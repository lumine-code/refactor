describe("Refactor provider selection ownership", () => {
  let editor, main, edge, grammar;
  beforeEach(async () => {
    const pkg = await lumine.packages.activatePackage("language-text");
    await pkg.resourceLoadPromise;
    editor = await lumine.workspace.open();
    editor.setText("symbol");
    grammar = editor.getGrammar();
    main = (await lumine.packages.activatePackage("refactor")).mainModule;
    spyOn(main, "promptForName").and.resolveTo("replacement");
  });
  afterEach(() => {
    edge?.dispose();
    editor.destroy();
  });

  for (const phase of ["selection", "preparation"]) {
    for (const restore of [false, true]) {
      it(`does not read source or prompt after ${phase} selects None${restore ? " then restores the grammar" : ""}`, async () => {
        let changed = false,
          armed = false;
        const provider = {
          get grammarScopes() {
            if (armed && !changed && (phase === "selection" || main.renameRequest)) {
              changed = true;
              editor.setGrammar(lumine.grammars.nullGrammar);
              if (restore) editor.setGrammar(grammar);
            }
            return [grammar.scopeName];
          },
          prepareRename: jasmine.createSpy("prepare").and.resolveTo(null),
          rename: jasmine.createSpy("rename").and.resolveTo(null),
        };
        edge = main.consumeRefactor(provider);
        armed = true;
        const read = spyOn(editor, "getTextInBufferRange").and.callThrough();
        await main.rename();
        expect(read).not.toHaveBeenCalled();
        expect(main.promptForName).not.toHaveBeenCalled();
        expect(provider.rename).not.toHaveBeenCalled();
        expect(provider.prepareRename).not.toHaveBeenCalled();
        editor.setGrammar(grammar);
        await main.rename();
        expect(main.promptForName).toHaveBeenCalledTimes(1);
        expect(provider.rename).toHaveBeenCalledTimes(1);
        expect(provider.prepareRename).toHaveBeenCalledTimes(1);
      });
    }
  }
});
