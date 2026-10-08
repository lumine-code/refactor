const fs = require("fs");
const os = require("os");
const path = require("path");
const { TextBuffer } = require("lumine");

describe("refactor request ownership", () => {
  let mainModule, packagePath, editor, directory, filePath, otherPath, providers;

  function deferred() {
    let resolve, reject;
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  async function flush() {
    for (let turn = 0; turn < 15; turn++) await Promise.resolve();
  }

  function provide(overrides = {}) {
    const provider = {
      grammarScopes: [editor.getGrammar().scopeName],
      rename: jasmine.createSpy("rename").and.resolveTo(null),
      ...overrides,
    };
    const edge = lumine.packages.serviceHub.provide("refactor.provider", "1.0.0", provider);
    providers.push(edge);
    return { provider, edge };
  }

  function edits() {
    return {
      outcome: "edits",
      edits: new Map([
        [
          filePath,
          [
            {
              oldRange: [
                [0, 0],
                [0, 3],
              ],
              newText: "new",
            },
          ],
        ],
        [
          otherPath,
          [
            {
              oldRange: [
                [0, 0],
                [0, 3],
              ],
              newText: "new",
            },
          ],
        ],
      ]),
    };
  }

  async function confirm(provider) {
    const pending = mainModule.rename();
    await conditionPromise(() => mainModule.dialog?.inputDialogHost.isVisible());
    const dialog = mainModule.dialog.inputDialog;
    dialog.getQueryEditor().setText("new");
    lumine.commands.dispatch(dialog.getElement(), "core:confirm");
    await conditionPromise(() => provider.rename.calls.count() === 1);
    return { pending };
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const pack = await lumine.packages.activatePackage("refactor");
    mainModule = pack.mainModule;
    packagePath = pack.path;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "rename-owned-"));
    filePath = path.join(directory, "origin.txt");
    otherPath = path.join(directory, "closed.txt");
    fs.writeFileSync(filePath, "old text");
    fs.writeFileSync(otherPath, "old target");
    editor = await lumine.workspace.open(filePath);
    editor.setCursorBufferPosition([0, 1]);
    providers = [];
  });

  afterEach(async () => {
    for (const provider of providers) provider.dispose();
    mainModule.dialog?.finish(null);
    await mainModule.dialog?.destroy();
    if (lumine.packages.isPackageActive("refactor"))
      await lumine.packages.deactivatePackage("refactor");
    for (const item of lumine.workspace.getTextEditors()) item.destroy();
    const relative = path.relative(os.tmpdir(), directory);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("Temporary directory escaped its root");
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("does not recreate a prompt when preparation completes after deactivation", async () => {
    const prepared = deferred();
    provide({ prepareRename: () => prepared.promise });
    spyOn(mainModule, "promptForName").and.callThrough();
    const pending = mainModule.rename();
    await lumine.packages.deactivatePackage("refactor");
    prepared.resolve({
      range: [
        [0, 0],
        [0, 3],
      ],
      placeholder: "old",
    });
    await flush();
    expect(mainModule.promptForName).not.toHaveBeenCalled();
    mainModule.dialog?.finish(null);
    await pending;
  });

  it("settles a pending prompt when its package is deactivated", async () => {
    provide();
    let settled = false;
    const pending = mainModule.rename().then(() => {
      settled = true;
    });
    await conditionPromise(() => mainModule.dialog?.inputDialogHost.isVisible());
    const oldDialog = mainModule.dialog;
    await lumine.packages.deactivatePackage("refactor");
    await flush();
    expect(settled).toBe(true);
    oldDialog.finish(null);
    await pending;
  });

  it("settles a superseded prompt without hiding or changing the newer prompt", async () => {
    provide();
    let settled = false;
    const first = mainModule.rename().then(() => {
      settled = true;
    });
    await conditionPromise(() => mainModule.dialog?.inputDialogHost.isVisible());
    const oldResolve = mainModule.dialog.resolve;
    editor.setCursorBufferPosition([0, 5]);
    const second = mainModule.rename();
    await flush();
    expect(settled).toBe(true);
    expect(mainModule.dialog.inputDialogHost.isVisible()).toBe(true);
    expect(mainModule.dialog.inputDialog.getQuery()).toBe("text");
    oldResolve?.(null);
    mainModule.dialog.finish(null);
    await Promise.all([first, second]);
  });

  it("does not retire a newer activation's reused provider when an old manual lease is disposed", async () => {
    const provider = {
      grammarScopes: [editor.getGrammar().scopeName],
      rename: jasmine.createSpy("rename").and.resolveTo(null),
    };
    const oldLease = mainModule.consumeRefactor(provider);
    await lumine.packages.deactivatePackage("refactor");
    mainModule = (await lumine.packages.activatePackage("refactor")).mainModule;
    const currentLease = mainModule.consumeRefactor(provider);
    providers.push(currentLease);
    const pending = mainModule.rename();
    await conditionPromise(() => mainModule.dialog?.inputDialogHost.isVisible());
    const request = mainModule.renameRequest;
    oldLease.dispose();
    expect(mainModule.providers).toContain(provider);
    expect(mainModule.renameRequest).toBe(request);
    expect(mainModule.dialog.inputDialogHost.isVisible()).toBe(true);
    mainModule.dialog.finish(null);
    await pending;
  });

  it("ignores a provider edit result returned after deactivation", async () => {
    const result = deferred();
    const { provider } = provide({
      rename: jasmine.createSpy("rename").and.returnValue(result.promise),
    });
    const { pending } = await confirm(provider);
    await lumine.packages.deactivatePackage("refactor");
    result.resolve(edits());
    await pending;
    expect(editor.getText()).toBe("old text");
    expect(fs.readFileSync(otherPath, "utf8")).toBe("old target");
  });

  it("does not overwrite source text edited while a provider response is pending", async () => {
    const result = deferred();
    const { provider } = provide({
      rename: jasmine.createSpy("rename").and.returnValue(result.promise),
    });
    const { pending } = await confirm(provider);
    editor.setText("User changed the text");
    result.resolve(edits());
    await pending;
    expect(editor.getText()).toBe("User changed the text");
    expect(fs.readFileSync(otherPath, "utf8")).toBe("old target");
  });

  it("rejects a withdrawn provider's pending edit result", async () => {
    const result = deferred();
    const { provider, edge } = provide({
      rename: jasmine.createSpy("rename").and.returnValue(result.promise),
    });
    const { pending } = await confirm(provider);
    edge.dispose();
    result.resolve(edits());
    await pending;
    expect(editor.getText()).toBe("old text");
    expect(fs.readFileSync(otherPath, "utf8")).toBe("old target");
  });

  for (const [context, change] of [
    ["path", (target) => target.getBuffer().setPath(path.join(directory, "changed.txt"))],
    ["cursor", (target) => target.setCursorBufferPosition([0, 5])],
    ["destroyed editor", (target) => target.destroy()],
  ]) {
    it(`does not open a prompt after preparation outlives its ${context} context`, async () => {
      const prepared = deferred();
      provide({ prepareRename: () => prepared.promise });
      spyOn(mainModule, "promptForName").and.resolveTo(null);
      const pending = mainModule.rename();
      change(editor);
      prepared.resolve({
        range: [
          [0, 0],
          [0, 3],
        ],
      });
      let failure;
      await pending.catch((error) => {
        failure = error;
      });
      expect(failure).toBeUndefined();
      expect(mainModule.promptForName).not.toHaveBeenCalled();
    });
  }

  it("suppresses retired provider errors rather than posting a late notification", async () => {
    const result = deferred();
    const { provider } = provide({
      rename: jasmine.createSpy("rename").and.returnValue(result.promise),
    });
    const { pending } = await confirm(provider);
    await lumine.packages.deactivatePackage("refactor");
    spyOn(lumine.notifications, "addError").and.callThrough();
    result.reject(new Error("Retired provider failed"));
    await pending;
    expect(lumine.notifications.addError).not.toHaveBeenCalled();
  });

  it("does not post an obsolete provider error after the source text changes", async () => {
    const result = deferred();
    const { provider } = provide({
      rename: jasmine.createSpy("rename").and.returnValue(result.promise),
    });
    const { pending } = await confirm(provider);
    editor.setText("User changed the source");
    spyOn(lumine.notifications, "addError").and.callThrough();
    result.reject(new Error("Old symbol request failed"));
    await pending;
    expect(lumine.notifications.addError).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("User changed the source");
  });

  it("abandons loaded-file edits without touching any target when loading outlives deactivation", async () => {
    const loaded = await TextBuffer.load(otherPath);
    const gate = deferred();
    const load = TextBuffer.load.bind(TextBuffer);
    spyOn(TextBuffer, "load").and.callFake((target) =>
      target === otherPath ? gate.promise : load(target),
    );
    const { provider } = provide({ rename: jasmine.createSpy("rename").and.resolveTo(edits()) });
    const { pending } = await confirm(provider);
    await conditionPromise(() => TextBuffer.load.calls.count() > 0);
    expect(editor.getText()).toBe("old text");
    await lumine.packages.deactivatePackage("refactor");
    gate.resolve(loaded);
    await pending;
    await conditionPromise(() => loaded.isDestroyed());
    expect(editor.getText()).toBe("old text");
    expect(fs.readFileSync(otherPath, "utf8")).toBe("old target");
  });

  it("preserves provider-owned applied edits without applying them a second time", async () => {
    lumine.config.set("refactor.offerUndoNotification", true);
    const { provider } = provide({
      rename: jasmine.createSpy("rename").and.callFake(() => {
        editor.setText("Provider already applied its rename");
        return Promise.resolve({ outcome: "applied", paths: [filePath] });
      }),
    });
    const { pending } = await confirm(provider);
    await pending;
    expect(editor.getText()).toBe("Provider already applied its rename");
    expect(
      lumine.notifications.getNotifications().some((item) => item.getType() === "success"),
    ).toBe(true);
  });

  it("leaves user changes in another target alone while unopened files are still loading", async () => {
    const targetPath = path.join(directory, "open-target.txt");
    fs.writeFileSync(targetPath, "old target");
    const targetEditor = await lumine.workspace.open(targetPath);
    lumine.workspace.paneForItem(editor).activateItem(editor);
    const loaded = await TextBuffer.load(otherPath);
    const gate = deferred();
    const load = TextBuffer.load.bind(TextBuffer);
    spyOn(TextBuffer, "load").and.callFake((target) =>
      target === otherPath ? gate.promise : load(target),
    );
    const result = edits();
    result.edits.set(targetPath, [
      {
        oldRange: [
          [0, 0],
          [0, 3],
        ],
        newText: "new",
      },
    ]);
    const { provider } = provide({ rename: jasmine.createSpy("rename").and.resolveTo(result) });
    const { pending } = await confirm(provider);
    await conditionPromise(() => TextBuffer.load.calls.count() > 0);
    targetEditor.setText("User changed this target");
    gate.resolve(loaded);
    await pending;
    expect(editor.getText()).toBe("old text");
    expect(targetEditor.getText()).toBe("User changed this target");
    expect(fs.readFileSync(otherPath, "utf8")).toBe("old target");
    expect(loaded.isDestroyed()).toBe(true);
  });

  it("does not save an isolated loaded buffer over a target opened while loading", async () => {
    const loaded = await TextBuffer.load(otherPath);
    const gate = deferred();
    const load = TextBuffer.load.bind(TextBuffer);
    spyOn(TextBuffer, "load").and.callFake((target) =>
      target === otherPath ? gate.promise : load(target),
    );
    const { provider } = provide({ rename: jasmine.createSpy("rename").and.resolveTo(edits()) });
    const { pending } = await confirm(provider);
    await conditionPromise(() => TextBuffer.load.calls.count() > 0);
    TextBuffer.load.and.callThrough();
    const newEditor = await lumine.workspace.open(otherPath);
    newEditor.setText("New open editor text");
    gate.resolve(loaded);
    await pending;
    expect(editor.getText()).toBe("old text");
    expect(newEditor.getText()).toBe("New open editor text");
    expect(fs.readFileSync(otherPath, "utf8")).toBe("old target");
    expect(loaded.isDestroyed()).toBe(true);
  });

  it("releases a loaded buffer if applying its edits fails before checkpoint ownership transfers", async () => {
    const apply = require(path.join(packagePath, "lib/apply-edits"));
    const loaded = await TextBuffer.load(otherPath);
    spyOn(TextBuffer, "load").and.resolveTo(loaded);
    spyOn(loaded, "destroy").and.callThrough();
    spyOn(apply, "applyEditsToBuffer").and.throwError("Controlled edit failure");
    try {
      await expectAsync(apply.execute(new Map([[otherPath, []]]))).toBeRejectedWithError(
        "Controlled edit failure",
      );
      expect(loaded.destroy).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(otherPath, "utf8")).toBe("old target");
    } finally {
      if (!loaded.isDestroyed()) loaded.destroy();
    }
  });
});
