const { CompositeDisposable, Disposable, Range } = require("atom");
const ApplyEdits = require("./apply-edits");

const RENAME_VIEW_ID = "refactor.rename";

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
    // A prompt still up belongs to a package that is going away. Cancelling it
    // resolves the pending `promptForName` too, so the rename in flight unwinds
    // instead of waiting forever on an answer that can no longer come.
    const session = atom.modals.getActiveSession();
    if (session?.rootSpec.id === RENAME_VIEW_ID) session.cancel("deactivate");
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

    // A provider that prepares successfully is tried first, but the others
    // stay in the running: a provider declining the rename itself falls
    // through to the next one below.
    let ordered = providers;
    let placeholder = null;
    try {
      for (const candidate of providers) {
        if (!candidate.prepareRename) continue;
        const prepared = await candidate.prepareRename(editor, range.start);
        if (!prepared) continue;
        ordered = [candidate, ...providers.filter((other) => other !== candidate)];
        if (prepared.range) range = Range.fromObject(prepared.range);
        placeholder = prepared.placeholder ?? null;
        break;
      }
    } catch (error) {
      this.showError(error);
      return;
    }

    // Pre-select the symbol so the user sees exactly what will be renamed.
    editor.setSelectedBufferRange(range);
    const originalText = editor.getTextInBufferRange(range);

    const newName = await this.promptForName(placeholder ?? originalText);
    if (!newName || newName === originalText) return;

    // A provider resolving to null cannot rename at this position, so the
    // next one gets a turn. Any other result belongs to the provider that
    // returned it and ends the search.
    let result = null;
    try {
      for (const candidate of ordered) {
        result = await candidate.rename(editor, range.start, newName);
        if (result) break;
      }
    } catch (error) {
      this.showError(error);
      return;
    }
    if (!result) return;
    // The provider applied the edit itself — it needed file create, rename, or
    // delete operations that only it can perform — so there is nothing left to
    // apply here, and undo belongs to the provider too.
    if (result.outcome === "applied") {
      if (this.offerUndoNotification) {
        atom.notifications.addSuccess("Rename succeeded", {
          dismissable: true,
          description: `${pluralize(result.paths?.length ?? 0, "file")} affected.`,
        });
      }
      return;
    }
    // Applying was declined or failed on the provider's side; it has already
    // told the user why.
    if (result.outcome === "aborted") return;
    if (!result.edits || result.edits.size === 0) return;

    let renameResponse;
    try {
      renameResponse = await ApplyEdits.execute(result.edits);
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

  // Resolves with the entered name, or with `undefined` when the prompt is
  // cancelled. The name is prefilled and fully selected, so typing replaces it.
  promptForName(initialName) {
    return atom.modals.input({
      id: RENAME_VIEW_ID,
      className: "refactor-dialog",
      value: initialName,
      willOpen: (session) =>
        session.setStatus({ message: "Enter the new symbol name.", severity: "info" }),
    });
  },

  showError(error) {
    atom.notifications.addError("Rename error", {
      dismissable: true,
      detail: error?.message ?? String(error),
      stack: error?.stack,
    });
  },
};
