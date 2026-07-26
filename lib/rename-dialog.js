const { InputDialogView } = require("@lumine-code/select-list");

// Modal prompt for the new symbol name, built on InputDialogView. `show()`
// resolves with the entered name on confirm and with `null` on cancel; the
// query editor is prefilled (and fully selected) with the current name.
module.exports = class RenameDialog {
  constructor() {
    this.resolve = null;
    this.inputDialogView = new InputDialogView({
      className: "refactor-dialog",
      infoMessage: "Enter the new symbol name.",
      didConfirm: () => this.close(this.inputDialogView.getQuery()),
      didCancel: () => this.close(null),
    });
  }

  show({ initialName }) {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.inputDialogView.update({ query: initialName });
      this.inputDialogView.show();
    });
  }

  close(value) {
    const resolve = this.resolve;
    this.resolve = null;
    this.inputDialogView.hide();
    if (resolve) resolve(value);
  }

  destroy() {
    this.inputDialogView.destroy();
  }
};
