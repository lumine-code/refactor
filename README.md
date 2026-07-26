# refactor

Rename symbols across the project via provider-backed edits.

Place the cursor on a symbol and run the rename command. A provider (typically a language-server backend) computes every location that refers to the symbol, and the package applies the edits like a project-wide find-and-replace — transactionally, with one undo step per buffer.

## Features

- **Project-wide rename**: renames every reference the provider reports, across all affected files.
- **Prepared ranges**: providers that support prepare-rename pre-select the exact symbol range and can prefill the dialog with a placeholder name.
- **Transactional edits**: each buffer is edited under a checkpoint; a failure in any file reverts all of them.
- **Unopened files**: files not open in the workspace are loaded, edited, and saved automatically; open buffers are saved only when the save setting allows it.
- **Undo notification**: optional success notification listing the affected files with an Undo button.

## Installation

To install `refactor` search for _refactor_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/refactor`.

## Commands

Commands available in `atom-text-editor`:

- `refactor:rename`: rename the symbol under the cursor across the project,
- `refactor:list-providers`: list the registered rename providers and their grammar scopes.

## Services

- **refactor.provider** (`^1.0.0`): consumed to request rename edits from providers such as IDE backend packages.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
