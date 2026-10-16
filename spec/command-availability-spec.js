describe("rename provider availability", () => {
  it("uses target grammar metadata without requesting rename or initializing dialogs", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    const main = (await lumine.packages.activatePackage("refactor")).mainModule;
    const editor = await lumine.workspace.open();
    editor.setText("alpha\nbeta");
    const target = editor.getElement();
    const available = () => lumine.commands.canDispatch(target, "refactor:rename");
    const provider = {
      grammarScopes: [editor.getGrammar().scopeName],
      rename: jasmine.createSpy("rename"),
      prepareRename: jasmine.createSpy("prepare"),
    };
    try {
      expect(available()).toBe(false);
      const edge = main.consumeRefactor(provider);
      expect(available()).toBe(true);
      expect(main.dialogs.size).toBe(0);
      expect(provider.prepareRename).not.toHaveBeenCalled();
      expect(provider.rename).not.toHaveBeenCalled();
      editor.addCursorAtBufferPosition([1, 0]);
      expect(available()).toBe(false);
      editor.setSelectedBufferRange([
        [0, 0],
        [0, 0],
      ]);
      edge.dispose();
      expect(available()).toBe(false);
    } finally {
      editor.destroy();
      await lumine.packages.deactivatePackage("refactor");
    }
  });
});
