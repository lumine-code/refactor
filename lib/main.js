const { CompositeDisposable, Disposable, Range } = require("atom");
const ApplyEdits = require("./apply-edits");

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function describeResponse(renameResponse) {
  const { editorFiles, bufferFiles } = renameResponse.describe();
  const total = editorFiles.length + bufferFiles.length;
  const lines = [`Rename succeeded. ${pluralize(total, "file")} affected.`];
  if (editorFiles.length > 0) {
    lines.push("", "Open files in workspace:", "", ...editorFiles.map((file) => `* \`${file}\``));
  }
  if (bufferFiles.length > 0) {
    lines.push("", "Other files:", "", ...bufferFiles.map((file) => `* \`${file}\``));
  }
  return lines.join("\n");
}

module.exports = {
  providers: [],

  activate() {
    this.offerUndoNotification = false;
    this.subscriptions = new CompositeDisposable(
      atom.commands.add("atom-text-editor:not([mini])", {
        "refactor:rename": (event) => this.rename(event),
        "refactor:list-providers": () => this.listProviders(),
      }),
      atom.config.observe("refactor.offerUndoNotification", (value) => {
        this.offerUndoNotification = value;
      }),
    );
  },

  deactivate() {
    this.dialog?.destroy();
    this.dialog = null;
    this.subscriptions.dispose();
    this.providers.length = 0;
  },

  consumeRefactor(provider) {
    this.providers.push(provider);
    return new Disposable(() => {
      const index = this.providers.indexOf(provider);
      if (index !== -1) this.providers.splice(index, 1);
    });
  },

  // Score for ranking providers: priority first, with a nudge so a provider
  // that supports `prepareRename` beats one that does not, all else equal.
  scoreProvider(provider) {
    return (provider.priority ?? 0) + (provider.prepareRename ? 0.001 : 0);
  },

  // Providers whose grammar scopes cover the editor's grammar, best first.
  // `grammarScopes` is a live getter on the provider, so it is re-read on
  // every invocation rather than snapshotted at consume time.
  providersForEditor(editor) {
    const scope = editor.getGrammar()?.scopeName;
    if (!scope) return [];
    return this.providers
      .filter((provider) => Array.from(provider.grammarScopes ?? []).includes(scope))
      .sort((a, b) => this.scoreProvider(b) - this.scoreProvider(a));
  },

  listProviders() {
    const lines = this.providers.map((provider) => {
      const scopes = Array.from(provider.grammarScopes ?? []).map((scope) => `\`${scope}\``);
      const name = provider.packageName ?? "unknown package";
      return `* \`${name}\`: ${scopes.length > 0 ? scopes.join(", ") : "no grammar scopes"}`;
    });
    atom.notifications.addInfo("Rename providers", {
      dismissable: true,
      description:
        lines.length > 0
          ? `Found ${pluralize(lines.length, "provider")} offering rename support:\n\n${lines.join("\n")}`
          : "No rename providers are registered.",
    });
  },

  async rename(event) {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) return;
    if (editor.getSelections().length > 1) {
      event?.abortKeyBinding?.();
      return;
    }

    const providers = this.providersForEditor(editor);
    if (providers.length === 0) {
      atom.notifications.addError("No provider", {
        description: "No provider is available to rename symbols in this kind of file.",
      });
      return;
    }

    // Start from the selection, or from the word under the cursor. A provider
    // that supports `prepareRename` may refine this range and may supply a
    // placeholder name; the first provider whose prepare call succeeds is the
    // one used for the rename itself.
    let range = editor.getSelectedBufferRange();
    if (range.isEmpty()) range = editor.getLastCursor().getCurrentWordBufferRange();

    let provider = null;
    let placeholder = null;
    try {
      for (const candidate of providers) {
        if (!candidate.prepareRename) continue;
        const prepared = await candidate.prepareRename(editor, range.start);
        if (!prepared) continue;
        provider = candidate;
        if (prepared.range) range = Range.fromObject(prepared.range);
        placeholder = prepared.placeholder ?? null;
        break;
      }
    } catch (error) {
      this.showError(error);
      return;
    }
    provider ??= providers[0];

    // Pre-select the symbol so the user sees exactly what will be renamed.
    editor.setSelectedBufferRange(range);
    const originalText = editor.getTextInBufferRange(range);

    const newName = await this.promptForName(placeholder ?? originalText);
    if (!newName || newName === originalText) return;

    let response;
    try {
      response = await provider.rename(editor, range.start, newName);
    } catch (error) {
      this.showError(error);
      return;
    }
    // `null` means the provider either cannot rename here or has already
    // applied the whole edit itself (e.g. it included file create/rename/
    // delete operations); either way there is nothing for us to apply or
    // report.
    if (!response || response.size === 0) return;

    let renameResponse;
    try {
      renameResponse = await ApplyEdits.execute(response);
    } catch (error) {
      this.showError(error);
      return;
    }

    if (this.offerUndoNotification) {
      const notification = atom.notifications.addSuccess("Rename succeeded", {
        dismissable: true,
        description: describeResponse(renameResponse),
        buttons: [
          {
            text: "Undo",
            onDidClick: async () => {
              await renameResponse.revert();
              notification.dismiss();
            },
          },
        ],
      });
      // Once the notification is gone the response can release the buffers it
      // loaded for files that were not open in the workspace.
      notification.onDidDismiss(() => renameResponse.dispose());
    } else {
      renameResponse.dispose();
    }
  },

  promptForName(initialName) {
    if (!this.dialog) {
      const RenameDialog = require("./rename-dialog");
      this.dialog = new RenameDialog();
    }
    return this.dialog.show({ initialName });
  },

  showError(error) {
    atom.notifications.addError("Rename error", {
      dismissable: true,
      detail: error?.message ?? String(error),
      stack: error?.stack,
    });
  },
};
