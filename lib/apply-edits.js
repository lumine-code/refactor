const { Range, TextBuffer } = require("lumine");

// Tracks everything a rename touched so the whole operation can be described,
// reverted, and disposed of as one unit. Open editors are indexed separately
// from the buffers we had to load ourselves for files that were not open.
class RenameResponse {
  constructor() {
    this.editorCheckpointIndex = new Map();
    this.bufferCheckpointIndex = new Map();
    this.editorSaveSettings = new Map();
  }

  dispose() {
    // A rename job likely loaded buffers for files that were not open in the
    // workspace; destroy them before dropping the index that references them.
    for (const buffer of this.bufferCheckpointIndex.keys()) {
      buffer.destroy();
    }
    this.editorCheckpointIndex.clear();
    this.bufferCheckpointIndex.clear();
    this.editorSaveSettings.clear();
  }

  addEditorCheckpoint(editor, checkpoint, shouldSave = false) {
    this.editorCheckpointIndex.set(editor, checkpoint);
    this.editorSaveSettings.set(editor, shouldSave);
  }

  addBufferCheckpoint(buffer, checkpoint) {
    this.bufferCheckpointIndex.set(buffer, checkpoint);
  }

  relativizePath(filePath) {
    const [, relative] = lumine.project.relativizePath(filePath);
    return relative;
  }

  describe() {
    const editorFiles = [...this.editorCheckpointIndex.keys()].map((editor) =>
      this.relativizePath(editor.getPath()),
    );
    const bufferFiles = [...this.bufferCheckpointIndex.keys()].map((buffer) =>
      this.relativizePath(buffer.getPath()),
    );
    return { editorFiles, bufferFiles };
  }

  // Reverts every buffer to its pre-rename checkpoint. Buffers that were
  // saved as part of the rename are saved again so the disk state reverts too.
  async revert() {
    const promises = [];
    for (const [editor, checkpoint] of this.editorCheckpointIndex) {
      editor.revertToCheckpoint(checkpoint);
      if (this.editorSaveSettings.get(editor)) promises.push(editor.save());
    }
    for (const [buffer, checkpoint] of this.bufferCheckpointIndex) {
      buffer.revertToCheckpoint(checkpoint);
      promises.push(buffer.save());
    }
    return Promise.all(promises);
  }
}

const ApplyEdits = {
  // Applies a provider's edits to a single `TextBuffer` under a checkpoint.
  // The edits arrive with `oldRange` as a range-compatible array; each range
  // is pinned with a marker first so that earlier replacements cannot shift
  // the positions of later ones. The changes are grouped into one undo step;
  // any failure reverts the buffer before rethrowing.
  applyEditsToBuffer(buffer, edits) {
    const checkpoint = buffer.createCheckpoint();
    const layer = buffer.addMarkerLayer();
    try {
      const markers = edits.map((edit) => layer.markRange(Range.fromObject(edit.oldRange)));
      edits.forEach((edit, index) => {
        buffer.setTextInRange(markers[index].getRange(), edit.newText);
      });
      buffer.groupChangesSinceCheckpoint(checkpoint);
      return checkpoint;
    } catch (error) {
      buffer.revertToCheckpoint(checkpoint);
      throw error;
    } finally {
      layer.destroy();
    }
  },

  findEditorForPath(filePath) {
    return (
      lumine.workspace.getTextEditors().find((editor) => editor.getPath() === filePath) ?? null
    );
  },

  shouldSaveEditor(editor) {
    if (editor.isModified()) return false;
    const scope = editor.getGrammar()?.scopeName;
    // The save-after-edit decision honors scoped settings, so a user can opt
    // into automatic saves for some languages only.
    return scope
      ? lumine.config.get("refactor.saveAfterEditInOpenBuffers", { scope: [scope] })
      : lumine.config.get("refactor.saveAfterEditInOpenBuffers");
  },

  // Applies a rename edit set — a `Map` of absolute file path to an array of
  // `{ oldRange, newText }` edits — across the workspace. Files that are open
  // are edited in place (and saved only per the saveAfterEditInOpenBuffers
  // setting when they were unmodified); files that are not open are loaded
  // into buffers, edited, and saved immediately. Resolves to a
  // `RenameResponse`; if any file fails, everything reverts and the error is
  // rethrown.
  async execute(fileMap) {
    const renameResponse = new RenameResponse();
    const promises = [];

    try {
      for (const [filePath, edits] of fileMap.entries()) {
        const editor = this.findEditorForPath(filePath);
        if (editor) {
          const shouldSave = this.shouldSaveEditor(editor);
          const checkpoint = this.applyEditsToBuffer(editor.getBuffer(), edits);
          renameResponse.addEditorCheckpoint(editor, checkpoint, shouldSave);
          if (shouldSave) promises.push(editor.save());
        } else {
          promises.push(
            TextBuffer.load(filePath).then((buffer) => {
              const checkpoint = this.applyEditsToBuffer(buffer, edits);
              renameResponse.addBufferCheckpoint(buffer, checkpoint);
              return buffer.save();
            }),
          );
        }
      }
      await Promise.all(promises);
      return renameResponse;
    } catch (error) {
      // A failure in any file reverts every file so the rename stays atomic.
      await Promise.allSettled(promises);
      await renameResponse.revert();
      renameResponse.dispose();
      throw error;
    }
  },
};

module.exports = ApplyEdits;
