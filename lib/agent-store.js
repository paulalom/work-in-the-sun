const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const LOCAL_DIR = path.join(PROJECT_ROOT, ".local");
const AGENT_COMMANDS_PATH =
  process.env.AGENT_COMMANDS_PATH ||
  process.env.CODEX_INBOX_PATH ||
  path.join(LOCAL_DIR, "agent-commands.jsonl");
const AGENT_EVENTS_PATH = process.env.AGENT_EVENTS_PATH || path.join(LOCAL_DIR, "agent-events.jsonl");
const AGENT_STATE_PATH = process.env.AGENT_STATE_PATH || path.join(LOCAL_DIR, "agent-state.json");

const TARGET_MODES = new Set(["existing", "new"]);
const EVENT_LEVELS = new Set(["progress", "result", "system", "warning", "error"]);

function titleCase(text) {
  return text
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function slugify(text) {
  return String(text || "default")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]:\\/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "default";
}

function cleanProvider(provider) {
  return String(provider || "agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";
}

function defaultAgentTarget() {
  const threadId = process.env.CODEX_THREAD_ID || "";
  const provider = process.env.AGENT_PROVIDER || "codex";
  const sessionHint = process.env.AGENT_SESSION_HINT || threadId || "current";
  const label = process.env.AGENT_LABEL || (threadId ? "Codex current chat" : "Desktop agent");

  return normalizeAgentTarget({
    id: threadId ? `codex:${threadId}` : undefined,
    provider,
    label,
    workspace: process.env.AGENT_WORKSPACE || PROJECT_ROOT,
    sessionHint,
    mode: "existing",
  });
}

function normalizeAgentTarget(input = {}) {
  const provider = cleanProvider(input.provider || input.agent);
  const workspace = String(
    input.workspace || input.workspacePath || input.project || process.env.AGENT_WORKSPACE || PROJECT_ROOT,
  ).trim();
  const sessionHint = String(
    input.sessionHint || input.session || input.chat || input.thread || input.route || "",
  ).trim();
  const mode = TARGET_MODES.has(input.mode) ? input.mode : input.new ? "new" : "existing";
  const route = String(input.route || input.label || sessionHint || mode).trim();
  const label = String(input.label || `${titleCase(provider)} / ${route}`).trim();
  const id = String(input.id || `${provider}:${slugify(workspace)}:${slugify(sessionHint || route || mode)}`).trim();

  return {
    id,
    provider,
    label,
    workspace,
    sessionHint,
    mode,
    route,
  };
}

async function ensureLocalDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await ensureLocalDir(filePath);
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function getActiveTarget() {
  const state = await readJsonFile(AGENT_STATE_PATH, {});
  return normalizeAgentTarget(state.activeTarget || defaultAgentTarget());
}

async function setActiveTarget(target) {
  const activeTarget = {
    ...normalizeAgentTarget(target),
    configuredAt: new Date().toISOString(),
  };

  await writeJsonFile(AGENT_STATE_PATH, { activeTarget });
  return activeTarget;
}

function compactRecord(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== ""));
}

async function appendCommand(command) {
  const text = String(command.text || "").trim();

  if (!text) {
    throw new Error("Missing command text.");
  }

  const record = compactRecord({
    id: command.id || crypto.randomUUID(),
    receivedAt: command.receivedAt || new Date().toISOString(),
    status: command.status || "queued",
    kind: "agent.command",
    input: command.input === "voice" ? "voice" : "text",
    source: ["manual", "auto", "command"].includes(command.source) ? command.source : "manual",
    echo: Boolean(command.echo),
    target: normalizeAgentTarget(command.target || (await getActiveTarget())),
    text,
  });

  await ensureLocalDir(AGENT_COMMANDS_PATH);
  await fsp.appendFile(AGENT_COMMANDS_PATH, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

async function appendEvent(event) {
  const text = String(event.text || "").trim();

  if (!text) {
    throw new Error("Missing event text.");
  }

  const level = EVENT_LEVELS.has(event.level) ? event.level : "progress";
  const target =
    event.target ||
    (event.targetId
      ? {
          id: event.targetId,
          label: event.targetId,
          provider: event.provider,
        }
      : undefined);
  const record = compactRecord({
    id: event.id || crypto.randomUUID(),
    receivedAt: event.receivedAt || new Date().toISOString(),
    kind: event.kind || "agent.feedback",
    level,
    source: String(event.source || "agent").trim(),
    commandId: String(event.commandId || "").trim(),
    target: target ? normalizeAgentTarget(target) : undefined,
    speak: event.speak === undefined ? undefined : Boolean(event.speak),
    text,
  });

  await ensureLocalDir(AGENT_EVENTS_PATH);
  await fsp.appendFile(AGENT_EVENTS_PATH, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

async function readJsonl(filePath, options = {}) {
  const after = Math.max(0, Number(options.after || 0));
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 500));

  try {
    const file = await fsp.readFile(filePath, "utf8");
    const lines = file.split(/\r?\n/).filter(Boolean);
    const start = Math.min(after, lines.length);
    const selected = lines.slice(start, start + limit);
    const records = [];

    selected.forEach((line, index) => {
      try {
        records.push({
          cursor: start + index + 1,
          ...JSON.parse(line),
        });
      } catch {
        records.push({
          cursor: start + index + 1,
          kind: "agent.parse-error",
          level: "warning",
          text: "A local agent record could not be parsed.",
        });
      }
    });

    return {
      cursor: start + selected.length,
      total: lines.length,
      records,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        cursor: 0,
        total: 0,
        records: [],
      };
    }

    throw error;
  }
}

async function readCommands(options) {
  return readJsonl(AGENT_COMMANDS_PATH, options);
}

async function readEvents(options) {
  return readJsonl(AGENT_EVENTS_PATH, options);
}

module.exports = {
  appendCommand,
  appendEvent,
  defaultAgentTarget,
  getActiveTarget,
  normalizeAgentTarget,
  paths: {
    commands: AGENT_COMMANDS_PATH,
    events: AGENT_EVENTS_PATH,
    state: AGENT_STATE_PATH,
  },
  readCommands,
  readEvents,
  setActiveTarget,
};
