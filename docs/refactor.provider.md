# refactor.provider

Renames a symbol across the project, and optionally validates the rename before the user types the new name.

|             |                                                       |
| ----------- | ----------------------------------------------------- |
| Version     | `1.0.0`                                               |
| Provided by | `provideRefactor()` returning one provider            |
| Consumed by | `consumeRefactor(provider)` returning a `Disposable`  |
| Owner       | [`refactor`](https://github.com/lumine-code/refactor) |

A language server reaches this through an `ide-client` adapter. Implement it directly for a renamer that is not a language server.

## Registration

In your `package.json`:

```json
{
  "providedServices": {
    "refactor.provider": {
      "versions": { "1.0.0": "provideRefactor" }
    }
  }
}
```

## Contract

```ts
type RefactorProvider = {
  rename(
    editor: TextEditor,
    position: Point,
    newName: string,
  ): Promise<Map<string, TextEdit[]> | null>;

  prepareRename?(
    editor: TextEditor,
    position: Point,
  ): Promise<{ range: Range; placeholder?: string } | null>;

  grammarScopes?: string[];
  priority?: number;
  packageName?: string;
};
```

| Member                              | Description                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `rename(editor, position, newName)` | Required. Resolves to a map of file path to edits, or `null` to decline.          |
| `prepareRename(editor, position)`   | Optional. Validates the position and refines the range before the prompt appears. |
| `grammarScopes`                     | Scope names you serve. A **live getter**, re-read on every invocation.            |
| `priority`                          | Higher is preferred. Defaults to `0`.                                             |
| `packageName`                       | Shown in the "Rename providers" listing.                                          |

## Minimal example

```js
module.exports = {
  provideRefactor() {
    return {
      packageName: "my-package",
      grammarScopes: ["source.mylang"],
      priority: 1,
      async prepareRename(editor, position) {
        const symbol = symbolAt(editor, position);
        return symbol ? { range: symbol.range, placeholder: symbol.name } : null;
      },
      async rename(editor, position, newName) {
        const symbol = symbolAt(editor, position);
        if (!symbol) return null;
        const edits = new Map();
        for (const occurrence of await findAll(symbol)) {
          const list = edits.get(occurrence.path) ?? [];
          list.push({ oldRange: occurrence.range, newText: newName });
          edits.set(occurrence.path, list);
        }
        return edits;
      },
    };
  },
};
```

## Behavior

Providers are ranked by `priority`, with a **small nudge for implementing `prepareRename`** — all else equal, a provider that can validate the position beats one that cannot.

`prepareRename` runs first, on each candidate in order, and the first one that succeeds becomes the preferred provider for the rename itself. Its `range` replaces the editor's guess at what is being renamed, and its `placeholder` pre-fills the prompt. Returning `null` means "not renameable here", and the next candidate is tried.

**The other providers stay in the running.** A provider that prepared successfully but then returns `null` from `rename` falls through to the next one rather than failing the operation.

Renaming is refused outright when the editor has multiple selections — you will not be called.

When no provider claims the grammar, the user gets an error notification naming the problem; the `refactor:list-providers` command shows which providers are registered and what they cover.

The returned map is keyed by absolute file path, and its edits are applied across every file at once.

## Teardown

`consumeRefactor` returns a `Disposable` that removes the provider. Return it from your consumer method.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
