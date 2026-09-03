// Modal prompt for the new symbol name, built on InputDialog. `show()`
// resolves with the entered name on confirm and with `null` on cancel; the
// query editor is prefilled (and fully selected) with the current name.
module.exports = class RenameDialog {
  constructor() {
    this.resolve = null;
    this.inputDialogView = lumine.workspace.buildInputDialog({
      className: "refactor-dialog",
      crumb: "Rename",
      infoMessage: "Enter the new symbol name.",
      commands: {
        "refactor:confirm-rename": {
          description: "Use the entered name for the pending symbol rename.",
          didDispatch: () => this.finish(this.inputDialogView.getQuery()),
        },
      },
      actions: [
        {
          command: "refactor:confirm-rename",
          context: "dialog",
          primary: true,
          disposition: "close",
          dispatch: "local",
        },
      ],
    });
    this.inputDialogView.onDidCancel(() => this.finish(null));
  }

  show({ initialName }) {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.inputDialogView.show({ query: initialName, selectQuery: true });
    });
  }

  finish(value) {
    const resolve = this.resolve;
    this.resolve = null;
    if (resolve) resolve(value);
  }

  destroy() {
    return this.inputDialogView.destroy();
  }
};
