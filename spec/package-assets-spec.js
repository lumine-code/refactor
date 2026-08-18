const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

// Guards for the pulsar-refactor -> refactor rebrand and modernization. The
// command prefix, config namespace, and package name all move to `refactor`;
// the hand-rolled dialog and the dedent dependency are gone.
describe("refactor package assets", () => {
  it("ships the keymap and menu as JSON under the refactor name", () => {
    expect(exists("keymaps/main.json")).toBe(true);
    expect(exists("menus/main.json")).toBe(true);
    expect(exists("keymaps/pulsar-refactor.json")).toBe(false);
    expect(exists("menus/pulsar-refactor.json")).toBe(false);

    const keymap = JSON.parse(read("keymaps/main.json"));
    expect(keymap["lumine-text-editor:not([mini])"]["f2"]).toBe("refactor:rename");

    const menu = JSON.parse(read("menus/main.json"));
    const flat = JSON.stringify(menu);
    expect(flat).toContain("Rename Symbol");
    expect(flat).toContain("refactor:rename");
    expect(flat).not.toContain("pulsar-refactor");
  });

  it("is named `refactor` and points at lumine-code", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("refactor");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/refactor");
    expect(pkg.bugs.url).toBe("https://github.com/lumine-code/refactor/issues");
    expect(pkg.description).toBe("Rename symbols across the project via provider-backed edits.");
    expect(read("README.md").split(/\r?\n/)[2]).toBe(pkg.description);
  });

  it("consumes the refactor.provider service at ^1.0.0", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.consumedServices["refactor.provider"].versions["^1.0.0"]).toBe("consumeRefactor");
    // The bare name was the hub's own package name, which said nothing about
    // what crosses the boundary.
    expect(pkg.consumedServices["refactor"]).toBeUndefined();
  });

  it("keeps its settings in the refactor namespace without order keys", () => {
    const pkg = JSON.parse(read("package.json"));
    const schema = pkg.configSchema;
    expect(schema.saveAfterEditInOpenBuffers.type).toBe("boolean");
    expect(schema.saveAfterEditInOpenBuffers.default).toBe(false);
    expect(schema.offerUndoNotification.type).toBe("boolean");
    expect(schema.offerUndoNotification.default).toBe(false);
    for (const entry of Object.values(schema)) {
      expect(entry.order).toBeUndefined();
    }
  });

  it("replaces the hand-rolled dialog with the editor's input dialog and drops dedent", () => {
    const pkg = JSON.parse(read("package.json"));
    // The dialog comes from lumine.workspace.buildInputDialog, so the package
    // declares no dependency for it at all.
    expect(pkg.dependencies).toBeUndefined();
    expect(exists("lib/dialog.js")).toBe(false);
    expect(exists("lib/element-builder.js")).toBe(false);
    expect(read("lib/rename-dialog.js")).toContain("lumine.workspace.buildInputDialog");
    expect(read("lib/rename-dialog.js")).not.toContain("@lumine-code/select-list");
  });

  it("has no leftover upstream branding in lib, keymaps, menus, or README", () => {
    const files = ["README.md", "keymaps/main.json", "menus/main.json"];
    for (const file of fs.readdirSync(path.join(root, "lib"))) {
      files.push(`lib/${file}`);
    }
    for (const file of files) {
      const source = read(file);
      expect(source).not.toContain("pulsar-refactor");
      expect(source).not.toMatch(/Pulsar/);
      expect(source).not.toMatch(/\bAtom\b/);
      expect(source).not.toContain("dedent");
    }
  });
});
