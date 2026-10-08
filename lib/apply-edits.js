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
    if (editor.getFileState() !== "unmodified") return false;
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
  async execute(fileMap, { isCurrent = () => true, willApply = () => {} } = {}) {
    const renameResponse = new RenameResponse();
    const promises = [];
    const loading = [];
    const loadedBuffers = new Set();
    const transferredBuffers = new Set();
    const subscriptions = [];
    const targets = [];
    let committed = false;
    const watch = (target, buffer) => {
      target.buffer = buffer;
      target.path = buffer.getPath();
      subscriptions.push(
        buffer.onDidChange(() => {
          target.changed = true;
        }),
      );
      subscriptions.push(
        buffer.onDidChangePath(() => {
          target.changed = true;
        }),
      );
    };
    const assertCurrent = (target) => {
      if (
        (committed || isCurrent()) &&
        (!target ||
          (!target.changed &&
            !target.buffer.isDestroyed() &&
            target.buffer.getPath() === target.path &&
            (target.editor
              ? !target.editor.isDestroyed() && target.editor.getBuffer() === target.buffer
              : !this.findEditorForPath(target.filePath))))
      )
        return;
      const error = new Error("Rename targets changed before the edits could be applied.");
      error.name = "AbortError";
      throw error;
    };

    try {
      for (const [filePath, edits] of fileMap.entries()) {
        const editor = this.findEditorForPath(filePath);
        const target = { filePath, edits, editor, changed: false };
        targets.push(target);
        if (editor) watch(target, editor.getBuffer());
        else
          loading.push(
            TextBuffer.load(filePath).then((buffer) => {
              loadedBuffers.add(buffer);
              watch(target, buffer);
            }),
          );
      }
      // Loading is still preparation: no buffer may be changed before the
      // originating request and all loaded targets have been checked again.
      await Promise.all(loading);
      assertCurrent();
      for (const target of targets) assertCurrent(target);
      willApply();
      committed = true;
      for (const target of targets) {
        assertCurrent(target);
        const { editor, buffer, edits } = target;
        if (editor) {
          const shouldSave = this.shouldSaveEditor(editor);
          const checkpoint = this.applyEditsToBuffer(editor.getBuffer(), edits);
          renameResponse.addEditorCheckpoint(editor, checkpoint, shouldSave);
          if (shouldSave) promises.push(editor.save());
        } else {
          const checkpoint = this.applyEditsToBuffer(buffer, edits);
          renameResponse.addBufferCheckpoint(buffer, checkpoint);
          transferredBuffers.add(buffer);
          promises.push(buffer.save());
        }
      }
      await Promise.all(promises);
      return renameResponse;
    } catch (error) {
      // A failure in any file reverts every file so the rename stays atomic.
      await Promise.allSettled([...loading, ...promises]);
      try {
        await renameResponse.revert();
      } finally {
        renameResponse.dispose();
      }
      throw error;
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      for (const buffer of loadedBuffers) {
        if (!transferredBuffers.has(buffer)) buffer.destroy();
      }
    }
  },
};

module.exports = ApplyEdits;
