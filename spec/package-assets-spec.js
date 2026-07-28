const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

// Guards for the pulsar-refactor -> refactor rebrand and modernization. The
// command prefix, config namespace, and package name all move to `refactor`;
// the hand-rolled dialog and the dedent dependency are gone, and the prompt is
// the editor's own modal rather than a bundled dialog library.
describe("refactor package assets", () => {
  it("ships the keymap and menu as JSON under the refactor name", () => {
    expect(exists("keymaps/refactor.json")).toBe(true);
    expect(exists("menus/refactor.json")).toBe(true);
    expect(exists("keymaps/pulsar-refactor.json")).toBe(false);
    expect(exists("menus/pulsar-refactor.json")).toBe(false);

    const keymap = JSON.parse(read("keymaps/refactor.json"));
    expect(keymap["atom-text-editor:not([mini])"]["f2"]).toBe("refactor:rename");

    const menu = JSON.parse(read("menus/refactor.json"));
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
    expect(read("README.md").split("\n")[2]).toBe(pkg.description);
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

  it("prompts through atom.modals and ships no runtime dependencies", () => {
    const pkg = JSON.parse(read("package.json"));
    // The prompt is one `atom.modals.input` call, so there is nothing left to
    // depend on at runtime: no dialog library, no dedent, no view class.
    expect(pkg.dependencies).toBeUndefined();
    expect(exists("lib/dialog.js")).toBe(false);
    expect(exists("lib/element-builder.js")).toBe(false);
    expect(exists("lib/rename-dialog.js")).toBe(false);
    expect(read("lib/main.js")).toContain("atom.modals.input");
  });

  it("has no leftover upstream branding in lib, keymaps, menus, or README", () => {
    const files = ["README.md", "keymaps/refactor.json", "menus/refactor.json"];
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
