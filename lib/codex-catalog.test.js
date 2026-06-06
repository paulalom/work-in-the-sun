const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function loadFreshCatalog(env) {
  const previous = {};

  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }

  delete require.cache[require.resolve("./agent-store")];
  delete require.cache[require.resolve("./codex-catalog")];

  const catalog = require("./codex-catalog");

  return {
    catalog,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }

      delete require.cache[require.resolve("./agent-store")];
      delete require.cache[require.resolve("./codex-catalog")];
    },
  };
}

test("lists project-like child folders under allowed workspace roots", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "wits-catalog-"));
  const codexHome = path.join(tempRoot, "codex-home");
  const workspaceRoot = path.join(tempRoot, "workspaces");
  const projectRoot = path.join(workspaceRoot, "scarcity-shores");

  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));

  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.writeFile(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({}), "utf8");
  await fsp.writeFile(path.join(projectRoot, "package.json"), "{}\n", "utf8");

  const { catalog, restore } = loadFreshCatalog({
    CODEX_HOME: codexHome,
    WITS_ALLOWED_WORKSPACE_ROOTS: workspaceRoot,
  });
  t.after(restore);

  const result = await catalog.listProjects({ limit: 25 });
  const discovered = result.projects.find((project) => project.workspace === path.resolve(projectRoot));

  assert.ok(discovered);
  assert.equal(discovered.label, "Scarcity Shores");

  const resolved = await catalog.resolveProject("scarcity shores");
  assert.equal(resolved.workspace, path.resolve(projectRoot));
});
