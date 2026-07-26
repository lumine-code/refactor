const fs = require("fs");
const os = require("os");
const path = require("path");

const packageRoot = path.join(__dirname, "..");

// Polls a real-clock condition; requires jasmine.useRealClock().
async function until(predicate, description = "condition", timeout = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describe("refactor", () => {
  let mainModule;
  let providerDisposable;
  let tempDir;
  let pathA;
  let pathB;
  let pathC;
  let editorA;
  let editorB;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    atom.notifications.clear();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-spec-"));
    pathA = path.join(tempDir, "a.js");
    pathB = path.join(tempDir, "b.js");
    pathC = path.join(tempDir, "c.js");
    fs.writeFileSync(pathA, "aaa bbb aaa\n");
    fs.writeFileSync(pathB, "xxx aaa\n");
    fs.writeFileSync(pathC, "aaa ccc\n");

    const pack = await atom.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;

    editorB = await atom.workspace.open(pathB);
    editorA = await atom.workspace.open(pathA);
    editorA.setCursorBufferPosition([0, 1]);
  });

  afterEach(async () => {
    providerDisposable?.dispose();
    providerDisposable = null;
    await atom.packages.deactivatePackage("refactor");
    for (const editor of atom.workspace.getTextEditors()) {
      editor.destroy();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function addProvider(overrides = {}) {
    const provider = {
      priority: 1,
      packageName: "refactor-spec-stub",
      get grammarScopes() {
        return [editorA.getGrammar().scopeName];
      },
      rename: jasmine.createSpy("rename").and.resolveTo(null),
      ...overrides,
    };
    providerDisposable = mainModule.consumeRefactor(provider);
    return provider;
  }

  function editsFor(newName) {
    return new Map([
      [
        pathA,
        [
          {
            oldRange: [
              [0, 0],
              [0, 3],
            ],
            newText: newName,
          },
          {
            oldRange: [
              [0, 8],
              [0, 11],
            ],
            newText: newName,
          },
        ],
      ],
      [
        pathB,
        [
          {
            oldRange: [
              [0, 4],
              [0, 7],
            ],
            newText: newName,
          },
        ],
      ],
      [
        pathC,
        [
          {
            oldRange: [
              [0, 0],
              [0, 3],
            ],
            newText: newName,
          },
        ],
      ],
    ]);
  }

  function findDialog() {
    const panel = atom.workspace
      .getModalPanels()
      .find((p) => p.isVisible() && p.getItem().element?.classList?.contains("refactor-dialog"));
    return panel ? panel.getItem() : null;
  }

  async function invokeRename() {
    atom.commands.dispatch(atom.views.getView(editorA), "refactor:rename");
    await until(() => findDialog() !== null, "the rename dialog to appear");
    return findDialog();
  }

  it("renames across open buffers and unopened files, one undo step per buffer", async () => {
    const provider = addProvider({
      rename: jasmine
        .createSpy("rename")
        .and.callFake(async (_editor, _position, newName) => editsFor(newName)),
    });

    const dialog = await invokeRename();
    // The dialog is prefilled with the word under the cursor.
    expect(dialog.refs.queryEditor.getText()).toBe("aaa");

    dialog.refs.queryEditor.setText("zzz");
    atom.commands.dispatch(dialog.element, "core:confirm");

    await until(() => editorA.getText() === "zzz bbb zzz\n", "editor A to be renamed");
    await until(() => editorB.getText() === "xxx zzz\n", "editor B to be renamed");
    await until(
      () => fs.readFileSync(pathC, "utf8") === "zzz ccc\n",
      "the unopened file to be renamed and saved",
    );
    expect(provider.rename).toHaveBeenCalledWith(editorA, jasmine.anything(), "zzz");
    expect(findDialog()).toBeNull();

    // Open buffers are not saved by default.
    expect(editorA.isModified()).toBe(true);
    expect(editorB.isModified()).toBe(true);

    // The edits in each buffer are grouped into a single undo step.
    editorA.undo();
    expect(editorA.getText()).toBe("aaa bbb aaa\n");
    editorB.undo();
    expect(editorB.getText()).toBe("xxx aaa\n");
  });

  it("uses prepareRename to pre-select the symbol and prefill the placeholder", async () => {
    addProvider({
      prepareRename: jasmine.createSpy("prepareRename").and.resolveTo({
        range: [
          [0, 8],
          [0, 11],
        ],
        placeholder: "prepared",
      }),
    });

    const dialog = await invokeRename();
    expect(editorA.getSelectedBufferRange().serialize()).toEqual([
      [0, 8],
      [0, 11],
    ]);
    expect(dialog.refs.queryEditor.getText()).toBe("prepared");

    atom.commands.dispatch(dialog.element, "core:cancel");
    await until(() => findDialog() === null, "the dialog to close");
  });

  it("shows nothing and raises no error when the provider resolves null", async () => {
    const provider = addProvider();

    const dialog = await invokeRename();
    dialog.refs.queryEditor.setText("zzz");
    atom.commands.dispatch(dialog.element, "core:confirm");

    await until(() => provider.rename.calls.count() === 1, "the provider to be invoked");
    await settle();

    expect(editorA.getText()).toBe("aaa bbb aaa\n");
    expect(editorB.getText()).toBe("xxx aaa\n");
    expect(fs.readFileSync(pathC, "utf8")).toBe("aaa ccc\n");
    expect(atom.notifications.getNotifications().length).toBe(0);
    expect(findDialog()).toBeNull();
  });

  it("reports a provider error as a notification", async () => {
    addProvider({
      rename: jasmine.createSpy("rename").and.rejectWith(new Error("cannot rename this")),
    });

    const dialog = await invokeRename();
    dialog.refs.queryEditor.setText("zzz");
    atom.commands.dispatch(dialog.element, "core:confirm");

    await until(
      () => atom.notifications.getNotifications().length === 1,
      "the error notification to appear",
    );
    const notification = atom.notifications.getNotifications()[0];
    expect(notification.getType()).toBe("error");
    expect(notification.getOptions().detail).toBe("cannot rename this");
    expect(editorA.getText()).toBe("aaa bbb aaa\n");
  });

  it("does not invoke the provider when the name is unchanged", async () => {
    const provider = addProvider();

    const dialog = await invokeRename();
    atom.commands.dispatch(dialog.element, "core:confirm");

    await until(() => findDialog() === null, "the dialog to close");
    await settle();
    expect(provider.rename).not.toHaveBeenCalled();
  });

  it("shows an error notification when no provider covers the grammar", async () => {
    addProvider({
      get grammarScopes() {
        return ["source.some-other-language"];
      },
    });

    atom.commands.dispatch(atom.views.getView(editorA), "refactor:rename");
    await until(
      () => atom.notifications.getNotifications().length === 1,
      "the no-provider notification to appear",
    );
    expect(atom.notifications.getNotifications()[0].getType()).toBe("error");
    expect(findDialog()).toBeNull();
  });

  it("lists registered providers in a notification", async () => {
    addProvider();

    atom.commands.dispatch(atom.views.getView(editorA), "refactor:list-providers");
    await until(
      () => atom.notifications.getNotifications().length === 1,
      "the provider list notification to appear",
    );
    const notification = atom.notifications.getNotifications()[0];
    expect(notification.getType()).toBe("info");
    expect(notification.getOptions().description).toContain("refactor-spec-stub");
  });
});
