const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

beforeEach(() => {
  for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
    if (!jasmine.isSpy(lumine.shell[method])) spyOn(lumine.shell, method).and.resolveTo();
  if (!jasmine.isSpy(lumine.application.openWindow))
    spyOn(lumine.application, "openWindow").and.resolveTo();
});

describe("Refactor command editor targets", () => {
  let main, first, second, third, firstPane, scratch, temporary, lease, provider;
  beforeEach(async () => {
    jasmine.useRealClock();
    if (lumine.packages.isPackageLoaded("refactor"))
      await lumine.packages.unloadPackage("refactor");
    temporary = fs.realpathSync.native(os.tmpdir());
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, "refactor-target-")));
    for (const name of ["first.txt", "second.txt", "third.txt"])
      fs.writeFileSync(path.join(scratch, name), "alpha\n");
    jasmine.attachToDOM(lumine.workspace.getElement());
    first = await lumine.workspace.open(path.join(scratch, "first.txt"));
    firstPane = lumine.workspace.paneForItem(first);
    firstPane.splitRight({ copyActiveItem: false });
    second = await lumine.workspace.open(path.join(scratch, "second.txt"));
    for (const editor of [first, second]) editor.setCursorBufferPosition([0, 2]);
    firstPane.activate();
    main = (await lumine.packages.activatePackage("refactor")).mainModule;
    provider = {
      grammarScopes: [first.getGrammar().scopeName],
      rename: jasmine
        .createSpy("rename accepted editor")
        .and.callFake(async (editor, _position, name) => ({
          edits: new Map([
            [
              editor.getPath(),
              [
                {
                  oldRange: [
                    [0, 0],
                    [0, 5],
                  ],
                  newText: name,
                },
              ],
            ],
          ]),
        })),
    };
  });
  afterEach(async () => {
    lease?.dispose();
    lease = null;
    if (lumine.packages.isPackageLoaded("refactor"))
      await lumine.packages.unloadPackage("refactor");
    first?.destroy();
    second?.destroy();
    third?.destroy();
    third = null;
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(fs.realpathSync.native(scratch)) !== temporary ||
      !path.basename(scratch).startsWith("refactor-target-")
    )
      throw new Error("Refactor fixture cleanup escaped its private temporary root");
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  function provide() {
    lease = lumine.packages.serviceHub.provide("refactor.provider", "1.0.0", provider);
  }
  async function rename(target) {
    const pending = lumine.commands.dispatch(target.getElement(), "refactor:rename");
    await conditionPromise(() => main.dialog?.inputDialogHost.isVisible());
    main.dialog.inputDialog.setQuery("omega");
    lumine.commands.dispatch(main.dialog.inputDialog.getElement(), "core:confirm");
    await pending;
  }
  it("renames the inactive split editor that invoked the command", async () => {
    provide();
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
    await rename(second);
    expect(provider.rename.calls.mostRecent().args[0]).toBe(second);
    expect(second.getText()).toBe("omega\n");
    expect(first.getText()).toBe("alpha\n");
  });
  it("keeps ordinary active-editor renaming", async () => {
    provide();
    await rename(first);
    expect(provider.rename.calls.mostRecent().args[0]).toBe(first);
    expect(first.getText()).toBe("omega\n");
    expect(second.getText()).toBe("alpha\n");
  });
  it("retires an unconfirmed request when another unrelated editor becomes active", async () => {
    let finish;
    provider.prepareRename = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    provide();
    const pending = lumine.commands.dispatch(second.getElement(), "refactor:rename");
    await conditionPromise(() => typeof finish === "function");
    third = await lumine.workspace.open(path.join(scratch, "third.txt"));
    finish({
      range: [
        [0, 0],
        [0, 5],
      ],
      placeholder: "alpha",
    });
    await pending;
    expect(main.dialog?.inputDialogHost.isVisible() ?? false).toBe(false);
    expect(provider.rename).not.toHaveBeenCalled();
    expect(first.getText()).toBe("alpha\n");
    expect(second.getText()).toBe("alpha\n");
  });
});
