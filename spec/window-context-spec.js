describe("rename prompts in editor windows", () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("refactor");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("refactor");
    await lumine.workspace.discardEditorWindows();
  });
  it("keeps two pending renames owned by their invoking windows", async () => {
    const workspace = lumine.workspace;
    const first = await workspace.open();
    first.setText("alpha");
    const extra = await workspace.openEditorWindow({ show: false });
    const second = workspace.buildTextEditor();
    second.setText("beta");
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    const main = lumine.packages.getActivePackage("refactor").mainModule;
    const provider = main.consumeRefactor({
      grammarScopes: [first.getGrammar().scopeName],
      rename: () => null,
    });
    const localPending = lumine.commands.dispatch(first.getElement(), "refactor:rename");
    await conditionPromise(() =>
      main.dialogs.get(workspace.getMainWindow())?.dialog.inputDialogHost.isVisible(),
    );
    const remotePending = lumine.commands.dispatch(second.getElement(), "refactor:rename");
    await conditionPromise(() => main.dialogs.get(extra)?.dialog.inputDialogHost.isVisible());
    const local = main.dialogs.get(workspace.getMainWindow()).dialog;
    const remote = main.dialogs.get(extra).dialog;
    expect(local.inputDialogHost.isVisible()).toBe(true);
    expect(remote.inputDialog.getElement().ownerDocument).toBe(extra.getDocument());
    expect(local.inputDialog.getQuery()).toBe("alpha");
    expect(remote.inputDialog.getQuery()).toBe("beta");
    remote.finish(null);
    await remotePending;
    expect(local.inputDialogHost.isVisible()).toBe(true);
    local.finish(null);
    await localPending;
    provider.dispose();
  });
});
