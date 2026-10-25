describe("refactor application menu document context", () => {
  // Analysis fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let main, first, second, extra, button, cell, notebook, lease, lookup;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());

    main = (await lumine.packages.activatePackage("refactor")).mainModule;
    first = await lumine.workspace.open();
    first.setText("first symbol");
    lookup = spyOn(main, "providersForEditor").and.returnValue([]);
  });
  afterEach(async () => {
    lease?.dispose();
    lease = null;
    await lumine.packages.deactivatePackage("refactor");
    button?.remove();
    button = null;
    if (notebook) {
      const pane = lumine.workspace.paneForItem(notebook);
      if (pane) await pane.destroyItem(notebook, true);
    }
    notebook = null;
    cell?.destroy();
    cell = null;
    await lumine.workspace.discardEditorWindows();
    first?.destroy();
  });
  it("uses the captured local editor when an unrelated surface belongs to another window", async () => {
    extra = await lumine.workspace.openEditorWindow({ show: false });
    second = lumine.workspace.buildTextEditor();
    second.setText("second symbol");
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    button = extra.getDocument().createElement("button");
    extra.getElement().appendChild(button);
    lumine.workspace.paneForItem(first).activate();
    button.focus();
    expect(lumine.workspace.resolveCommandContext(button).embeddedEditor).toBe(second);
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
    await lumine.commands.dispatch(button, "refactor:rename");
    expect(lookup.calls.mostRecent().args[0]).toBe(second);
  });
  it("uses the embedded document editor when a notebook owns the active pane item", async () => {
    cell = lumine.workspace.buildTextEditor();
    cell.setText("notebook symbol");
    const element = document.createElement("div");
    notebook = {
      getTitle: () => "Notebook",
      getElement: () => element,
      getActiveEmbeddedTextEditor: () => cell,
      destroy: () => element.remove(),
    };
    lumine.workspace.getActivePane().activateItem(notebook, { activatePane: true });
    button = document.createElement("button");
    element.appendChild(button);
    button.focus();
    expect(lumine.workspace.getActiveTextEditor()).toBeUndefined();
    expect(lumine.workspace.resolveCommandContext(button).embeddedEditor).toBe(cell);
    await lumine.commands.dispatch(button, "refactor:rename");
    expect(lookup.calls.mostRecent().args[0]).toBe(cell);
  });
  it("does nothing in an empty auxiliary window while the main window still has an editor", async () => {
    extra = await lumine.workspace.openEditorWindow({ show: false });
    button = extra.getDocument().createElement("button");
    extra.getElement().appendChild(button);
    lumine.workspace.paneForItem(first).activate();
    button.focus();
    const context = lumine.workspace.resolveCommandContext(button);
    expect(context.window).toBe(extra);
    expect(context.embeddedEditor).toBeUndefined();
    expect(context.editor).toBeUndefined();
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
    await lumine.commands.dispatch(button, "refactor:rename");
    expect(lumine.commands.canDispatch(button, "refactor:rename")).toBe(false);
    expect(main.commandEditor({ target: button, context })).toBe(null);
    expect(main.renameRequests.size).toBe(0);
    expect(main.dialogs.size).toBe(0);
  });
  it("retains the active-editor fallback for programmatic requests without command context", async () => {
    await main.rename();
    expect(lookup.calls.mostRecent().args[0]).toBe(first);
  });
});
