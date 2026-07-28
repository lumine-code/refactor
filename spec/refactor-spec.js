const fs = require("fs");
const os = require("os");
const path = require("path");

const packageRoot = path.join(__dirname, "..");

// The shared modal spec helpers live in the editor checkout, which sits beside
// this repository in CI and one level further up in the development workspace.
// Walk up rather than committing to either depth.
function requireModalHelpers() {
  let directory = packageRoot;
  for (;;) {
    const candidate = path.join(directory, "lumine", "spec", "helpers", "modal-helpers.js");
    if (fs.existsSync(candidate)) return require(candidate);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("refactor spec: could not locate the editor's modal spec helpers");
}

const { isModalOpen, queryText, setQuery, confirm, cancel, statusText } = requireModalHelpers();

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

  async function invokeRename() {
    atom.commands.dispatch(atom.views.getView(editorA), "refactor:rename");
    // `isOpen()` is true from the synchronous `open()` call, which is before
    // `willOpen` has resolved and before the frame is mounted — so the query is
    // not prefilled yet. Settle once more so assertions read the mounted view.
    await until(() => isModalOpen(), "the rename prompt to appear");
    await settle();
  }

  it("renames across open buffers and unopened files, one undo step per buffer", async () => {
    const provider = addProvider({
      rename: jasmine
        .createSpy("rename")
        .and.callFake(async (_editor, _position, newName) => resultFor(newName)),
    });

    await invokeRename();
    // The prompt is prefilled with the word under the cursor.
    expect(queryText()).toBe("aaa");
    expect(statusText()).toContain("Enter the new symbol name.");

    setQuery("zzz");
    confirm();

    await until(() => editorA.getText() === "zzz bbb zzz\n", "editor A to be renamed");
    await until(() => editorB.getText() === "xxx zzz\n", "editor B to be renamed");
    await until(
      () => fs.readFileSync(pathC, "utf8") === "zzz ccc\n",
      "the unopened file to be renamed and saved",
    );
    expect(provider.rename).toHaveBeenCalledWith(editorA, jasmine.anything(), "zzz");
    expect(isModalOpen()).toBe(false);

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

    await invokeRename();
    expect(editorA.getSelectedBufferRange().serialize()).toEqual([
      [0, 8],
      [0, 11],
    ]);
    expect(queryText()).toBe("prepared");

    cancel();
    await until(() => !isModalOpen(), "the prompt to close");
  });

  it("shows nothing and raises no error when the provider resolves null", async () => {
    const provider = addProvider();

    await invokeRename();
    setQuery("zzz");
    confirm();

    await until(() => provider.rename.calls.count() === 1, "the provider to be invoked");
    await settle();

    expect(editorA.getText()).toBe("aaa bbb aaa\n");
    expect(editorB.getText()).toBe("xxx aaa\n");
    expect(fs.readFileSync(pathC, "utf8")).toBe("aaa ccc\n");
    expect(atom.notifications.getNotifications().length).toBe(0);
    expect(isModalOpen()).toBe(false);
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

    await invokeRename();
    setQuery("zzz");
    confirm();

    await until(() => editorA.getText() === "zzz bbb zzz\n", "the fallback provider to rename");
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

    await invokeRename();
    setQuery("zzz");
    confirm();

    await until(() => aborting.rename.calls.count() === 1, "the provider to be invoked");
    await settle();

    // Aborting is the provider's final word: renaming again through another
    // provider would defeat the user declining it.
    expect(fallback.rename).not.toHaveBeenCalled();
    expect(editorA.getText()).toBe("aaa bbb aaa\n");
    expect(atom.notifications.getNotifications().length).toBe(0);
    fallbackDisposable.dispose();
  });

  it("applies nothing itself when the provider already applied the edit", async () => {
    atom.config.set("refactor.offerUndoNotification", true);
    const provider = addProvider({
      rename: jasmine
        .createSpy("rename")
        .and.resolveTo({ outcome: "applied", paths: [pathA, pathB] }),
    });

    await invokeRename();
    setQuery("zzz");
    confirm();

    await until(
      () => atom.notifications.getNotifications().length === 1,
      "the success notification to appear",
    );
    expect(provider.rename).toHaveBeenCalled();
    // The provider owns those edits; the buffers here are untouched by us.
    expect(editorA.getText()).toBe("aaa bbb aaa\n");
    const notification = atom.notifications.getNotifications()[0];
    expect(notification.getType()).toBe("success");
    expect(notification.getOptions().description).toContain("2 files");
  });

  it("reports a provider error as a notification", async () => {
    addProvider({
      rename: jasmine.createSpy("rename").and.rejectWith(new Error("cannot rename this")),
    });

    await invokeRename();
    setQuery("zzz");
    confirm();

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

    await invokeRename();
    confirm();

    await until(() => !isModalOpen(), "the prompt to close");
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
    expect(isModalOpen()).toBe(false);
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
