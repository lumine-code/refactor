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

// Named rather than counted, so a leaked notification names itself in the
// failure instead of reporting "expected 1 to be 0".
const notificationSummaries = () =>
  lumine.notifications.getNotifications().map((n) => `${n.getType()}: ${n.getMessage()}`);

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
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    lumine.notifications.clear();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "refactor-spec-"));
    pathA = path.join(tempDir, "a.js");
    pathB = path.join(tempDir, "b.js");
    pathC = path.join(tempDir, "c.js");
    fs.writeFileSync(pathA, "aaa bbb aaa\n");
    fs.writeFileSync(pathB, "xxx aaa\n");
    fs.writeFileSync(pathC, "aaa ccc\n");

    const pack = await lumine.packages.activatePackage(packageRoot);
    mainModule = pack.mainModule;

    editorB = await lumine.workspace.open(pathB);
    editorA = await lumine.workspace.open(pathA);
    editorA.setCursorBufferPosition([0, 1]);
  });

  afterEach(async () => {
    providerDisposable?.dispose();
    providerDisposable = null;
    await lumine.packages.deactivatePackage("refactor");
    for (const editor of lumine.workspace.getTextEditors()) {
      editor.destroy();
    }
    // Retries because Windows keeps a directory non-empty until the last handle on a child
    // closes, and `force` swallows only ENOENT.
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

  function resultFor(newName) {
    return { outcome: "edits", edits: editsFor(newName) };
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
    const panel = lumine.workspace
      .getModalPanels()
      .find((p) => p.isVisible() && p.getItem().element?.classList?.contains("refactor-dialog"));
    return panel ? panel.getItem() : null;
  }

  async function invokeRename() {
    lumine.commands.dispatch(lumine.views.getView(editorA), "refactor:rename");
    await until(() => findDialog() !== null, "the rename dialog to appear");
    return findDialog();
  }

  it("renames across open buffers and unopened files, one undo step per buffer", async () => {
    const provider = addProvider({
      rename: jasmine
        .createSpy("rename")
        .and.callFake(async (_editor, _position, newName) => resultFor(newName)),
    });

    const dialog = await invokeRename();
    // The dialog is prefilled with the word under the cursor.
    expect(dialog.refs.queryEditor.getText()).toBe("aaa");

    dialog.refs.queryEditor.setText("zzz");
    lumine.commands.dispatch(dialog.element, "core:confirm");

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

    lumine.commands.dispatch(dialog.element, "core:cancel");
    await until(() => findDialog() === null, "the dialog to close");
  });

  it("shows nothing and raises no error when the provider resolves null", async () => {
    const provider = addProvider();

    const dialog = await invokeRename();
    dialog.refs.queryEditor.setText("zzz");
    lumine.commands.dispatch(dialog.element, "core:confirm");

    await until(() => provider.rename.calls.count() === 1, "the provider to be invoked");
    await settle();

    expect(editorA.getText()).toBe("aaa bbb aaa\n");
    expect(editorB.getText()).toBe("xxx aaa\n");
    expect(fs.readFileSync(pathC, "utf8")).toBe("aaa ccc\n");
    expect(notificationSummaries()).toEqual([]);
    expect(findDialog()).toBeNull();
  });

  it("falls through to the next provider when the first one declines", async () => {
    const declining = addProvider();
    const accepting = {
      priority: 0,
      packageName: "refactor-spec-fallback",
      get grammarScopes() {
        return [editorA.getGrammar().scopeName];
      },
      rename: jasmine
        .createSpy("rename")
        .and.callFake(async (_editor, _position, newName) => resultFor(newName)),
    };
    const fallbackDisposable = mainModule.consumeRefactor(accepting);

    const dialog = await invokeRename();
    dialog.refs.queryEditor.setText("zzz");
    lumine.commands.dispatch(dialog.element, "core:confirm");

    await until(() => editorA.getText() === "zzz bbb zzz\n", "the fallback provider to rename");
    // The edits reach an unopened file too, which is loaded and saved rather
    // than applied to a buffer. Waiting only on the open editor lets the spec
    // end mid-save, and teardown then removes the directory out from under it
    // -- the save fails, and the error notification it raises lands in
    // whichever spec is running by then.
    await until(
      () => fs.readFileSync(pathC, "utf8") === "zzz ccc\n",
      "the unopened file to finish saving",
    );
    expect(declining.rename).toHaveBeenCalled();
    expect(accepting.rename).toHaveBeenCalled();
    fallbackDisposable.dispose();
  });

  it("stops without falling through when the provider aborts applying", async () => {
    const aborting = addProvider({
      rename: jasmine.createSpy("rename").and.resolveTo({ outcome: "aborted" }),
    });
    const fallback = {
      priority: 0,
      packageName: "refactor-spec-fallback",
      get grammarScopes() {
        return [editorA.getGrammar().scopeName];
      },
      rename: jasmine
        .createSpy("rename")
        .and.callFake(async (_editor, _position, newName) => resultFor(newName)),
    };
    const fallbackDisposable = mainModule.consumeRefactor(fallback);

    const dialog = await invokeRename();
    dialog.refs.queryEditor.setText("zzz");
    lumine.commands.dispatch(dialog.element, "core:confirm");

    await until(() => aborting.rename.calls.count() === 1, "the provider to be invoked");
    await settle();

    // Aborting is the provider's final word: renaming again through another
    // provider would defeat the user declining it.
    expect(fallback.rename).not.toHaveBeenCalled();
    expect(editorA.getText()).toBe("aaa bbb aaa\n");
    expect(notificationSummaries()).toEqual([]);
    fallbackDisposable.dispose();
  });

  it("applies nothing itself when the provider already applied the edit", async () => {
    lumine.config.set("refactor.offerUndoNotification", true);
    const provider = addProvider({
      rename: jasmine
        .createSpy("rename")
        .and.resolveTo({ outcome: "applied", paths: [pathA, pathB] }),
    });

    const dialog = await invokeRename();
    dialog.refs.queryEditor.setText("zzz");
    lumine.commands.dispatch(dialog.element, "core:confirm");

    await until(
      () => lumine.notifications.getNotifications().length === 1,
      "the success notification to appear",
    );
    expect(provider.rename).toHaveBeenCalled();
    // The provider owns those edits; the buffers here are untouched by us.
    expect(editorA.getText()).toBe("aaa bbb aaa\n");
    const notification = lumine.notifications.getNotifications()[0];
    expect(notification.getType()).toBe("success");
    expect(notification.getOptions().description).toContain("2 files");
  });

  it("reports a provider error as a notification", async () => {
    addProvider({
      rename: jasmine.createSpy("rename").and.rejectWith(new Error("cannot rename this")),
    });

    const dialog = await invokeRename();
    dialog.refs.queryEditor.setText("zzz");
    lumine.commands.dispatch(dialog.element, "core:confirm");

    await until(
      () => lumine.notifications.getNotifications().length === 1,
      "the error notification to appear",
    );
    const notification = lumine.notifications.getNotifications()[0];
    expect(notification.getType()).toBe("error");
    expect(notification.getOptions().detail).toBe("cannot rename this");
    expect(editorA.getText()).toBe("aaa bbb aaa\n");
  });

  it("does not invoke the provider when the name is unchanged", async () => {
    const provider = addProvider();

    const dialog = await invokeRename();
    lumine.commands.dispatch(dialog.element, "core:confirm");

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

    lumine.commands.dispatch(lumine.views.getView(editorA), "refactor:rename");
    await until(
      () => lumine.notifications.getNotifications().length === 1,
      "the no-provider notification to appear",
    );
    expect(lumine.notifications.getNotifications()[0].getType()).toBe("error");
    expect(findDialog()).toBeNull();
  });

  it("lists registered providers in a notification", async () => {
    addProvider();

    lumine.commands.dispatch(lumine.views.getView(editorA), "refactor:list-providers");
    await until(
      () => lumine.notifications.getNotifications().length === 1,
      "the provider list notification to appear",
    );
    const notification = lumine.notifications.getNotifications()[0];
    expect(notification.getType()).toBe("info");
    expect(notification.getOptions().description).toContain("refactor-spec-stub");
  });
});
