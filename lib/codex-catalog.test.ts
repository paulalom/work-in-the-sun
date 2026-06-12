const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function loadFreshCatalog(env: Record<string, string>) {
  const previous: Record<string, string | undefined> = {};

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

test("includes compact thread message context with listed chats", async (t) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "wits-catalog-"));
  const codexHome = path.join(tempRoot, "codex-home");
  const workspaceRoot = path.join(tempRoot, "workspaces");
  const projectRoot = path.join(workspaceRoot, "sun-room");
  const threadId = "123e4567-e89b-12d3-a456-426614174000";

  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));

  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.mkdir(projectRoot, { recursive: true });
  await fsp.writeFile(path.join(projectRoot, "package.json"), "{}\n", "utf8");
  await fsp.writeFile(
    path.join(codexHome, ".codex-global-state.json"),
    JSON.stringify({
      "active-workspace-roots": [projectRoot],
      "thread-workspace-root-hints": {
        [threadId]: projectRoot,
      },
    }),
    "utf8",
  );
  await fsp.writeFile(
    path.join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({
      id: threadId,
      thread_name: "Thread with context",
      updated_at: "2026-06-12T12:00:00.000Z",
    })}\n`,
    "utf8",
  );

  const { catalog, restore } = loadFreshCatalog({
    CODEX_HOME: codexHome,
    WITS_ALLOWED_WORKSPACE_ROOTS: workspaceRoot,
    AGENT_COMMANDS_PATH: path.join(tempRoot, "agent-commands.jsonl"),
    AGENT_EVENTS_PATH: path.join(tempRoot, "agent-events.jsonl"),
    AGENT_STATE_PATH: path.join(tempRoot, "agent-state.json"),
    AGENT_THREAD_LOG_DIR: path.join(tempRoot, "thread-logs"),
  });
  t.after(restore);

  const agentStore = require("./agent-store");
  const command = await agentStore.appendCommand({
    id: "cmd-1",
    text: "Summarize the plan.",
    userText: "Summarize the plan.",
    target: {
      provider: "codex",
      workspace: projectRoot,
      sessionHint: threadId,
      mode: "existing",
      route: threadId,
      label: "Codex / Thread with context",
    },
    status: "dispatching",
  });
  await agentStore.appendEvent({
    id: "evt-1",
    commandId: command.id,
    level: "result",
    text: "Plan summarized.",
    target: command.target,
  });

  const result = await catalog.listChats({ limit: 10 });
  const chat = result.chats.find((item) => item.id === threadId);

  assert.ok(chat);
  assert.deepEqual(
    chat.messages.map((message) => ({
      id: message.id,
      type: message.type,
      text: message.text,
      dispatchStatus: message.dispatchStatus,
    })),
    [
      {
        id: "command:cmd-1",
        type: "user",
        text: "Summarize the plan.",
        dispatchStatus: "sent",
      },
      {
        id: "event:evt-1",
        type: "agent",
        text: "Plan summarized.",
        dispatchStatus: undefined,
      },
    ],
  );
});
