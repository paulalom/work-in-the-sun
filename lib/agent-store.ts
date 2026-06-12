import type { JsonRecord } from "./types";

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const { PROJECT_ROOT } = require("./project-root");

const LOCAL_DIR = path.join(PROJECT_ROOT, ".local");
const AGENT_COMMANDS_PATH =
  process.env.AGENT_COMMANDS_PATH ||
  process.env.CODEX_INBOX_PATH ||
  path.join(LOCAL_DIR, "agent-commands.jsonl");
const AGENT_EVENTS_PATH = process.env.AGENT_EVENTS_PATH || path.join(LOCAL_DIR, "agent-events.jsonl");
const AGENT_STATE_PATH = process.env.AGENT_STATE_PATH || path.join(LOCAL_DIR, "agent-state.json");
const AGENT_THREAD_LOG_DIR = process.env.AGENT_THREAD_LOG_DIR || path.join(LOCAL_DIR, "agent-thread-messages");

const TARGET_MODES = new Set(["existing", "new"]);
const TARGET_DELIVERY_MODES = new Set(["windows-ui", "app-server-stdio"]);
const EVENT_LEVELS = new Set(["progress", "result", "system", "warning", "error"]);
const THREAD_MESSAGE_TYPES = new Set(["agent", "system", "user", "warning"]);
const REPLY_MODES = new Set(["normal", "concise"]);
const MAX_COMMAND_TEXT_CHARS = finitePositiveNumber(process.env.WITS_MAX_COMMAND_TEXT_CHARS, 8000);
const MAX_EVENT_TEXT_CHARS = finitePositiveNumber(process.env.WITS_MAX_EVENT_TEXT_CHARS, 12000);
const MAX_THREAD_LOG_BYTES = finitePositiveNumber(process.env.WITS_MAX_THREAD_LOG_BYTES, 10 * 1024);
const MAX_THREAD_MESSAGE_CHARS = finitePositiveNumber(process.env.WITS_MAX_THREAD_MESSAGE_CHARS, 1200);
const THREAD_CONTEXT_MESSAGE_LIMIT = finitePositiveNumber(process.env.WITS_THREAD_CONTEXT_MESSAGE_LIMIT, 4);
const MAX_LABEL_CHARS = finitePositiveNumber(process.env.WITS_MAX_LABEL_CHARS, 160);
const MAX_ROUTE_CHARS = finitePositiveNumber(process.env.WITS_MAX_ROUTE_CHARS, 240);
const MAX_ID_CHARS = finitePositiveNumber(process.env.WITS_MAX_ID_CHARS, 240);
const MAX_REPLY_NOTE_CHARS = finitePositiveNumber(process.env.WITS_MAX_REPLY_NOTE_CHARS, 240);
const DEFAULT_CONCISE_REPLY_WORDS = finitePositiveNumber(process.env.WITS_CONCISE_REPLY_WORDS, 28);
const FEED_TRUNCATION_SUFFIX = "...";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ALLOWED_PROVIDERS = parseCsv(process.env.WITS_ALLOWED_AGENT_PROVIDERS || "codex,agent");
const ALLOWED_WORKSPACE_ROOTS = uniquePaths([
  PROJECT_ROOT,
  process.env.AGENT_WORKSPACE,
  ...parsePathList(process.env.WITS_ALLOWED_WORKSPACE_ROOTS || process.env.AGENT_ALLOWED_WORKSPACE_ROOTS || ""),
]);

function finitePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseCsv(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parsePathList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniquePaths(paths) {
  const seen = new Set();
  const roots = [];

  for (const item of paths) {
    if (!item) {
      continue;
    }

    const resolved = path.resolve(String(item));
    const key = resolved.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    roots.push(resolved);
  }

  return roots;
}

function sanitizeText(value, fieldName, maxChars) {
  const text = String(value || "").replace(/\0/g, "").trim();

  if (text.length > maxChars) {
    throw new Error(`${fieldName} is too long.`);
  }

  return text;
}

function ensureAllowedProvider(provider) {
  if (ALLOWED_PROVIDERS.size && !ALLOWED_PROVIDERS.has(provider)) {
    throw new Error(`Agent provider is not allowed: ${provider}.`);
  }
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isWorkspaceAllowed(workspace) {
  const resolved = path.resolve(String(workspace || PROJECT_ROOT));
  return ALLOWED_WORKSPACE_ROOTS.some((root) => isPathInside(resolved, root));
}

function normalizeWorkspace(workspace) {
  const resolved = path.resolve(sanitizeText(workspace || PROJECT_ROOT, "Workspace", MAX_ID_CHARS));

  if (!isWorkspaceAllowed(resolved)) {
    throw new Error("Workspace is outside the allowed roots.");
  }

  return resolved;
}

function extractThreadId(target: JsonRecord = {}) {
  const candidates = [target.sessionHint, target.threadId, target.id, target.route, target.label]
    .filter(Boolean)
    .map(String);

  for (const candidate of candidates) {
    const match = candidate.match(UUID_PATTERN);

    if (match) {
      return match[0];
    }
  }

  return "";
}

function normalizeThreadLogProvider(target: JsonRecord = {}) {
  return String(target.provider || target.agent || "agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";
}

function threadLogKeyFromTarget(input: JsonRecord | string = {}) {
  const target = typeof input === "string" ? { provider: "codex", sessionHint: input } : input || {};
  const threadId = extractThreadId(target);

  if (!threadId) {
    return "";
  }

  return `${normalizeThreadLogProvider(target)}:thread:${threadId.toLowerCase()}`;
}

function threadLogPath(threadKey: string) {
  const readable = String(threadKey || "thread")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "thread";
  const digest = crypto.createHash("sha256").update(threadKey).digest("hex").slice(0, 16);

  return path.join(AGENT_THREAD_LOG_DIR, `${readable}-${digest}.jsonl`);
}

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
  const cleaned = String(provider || "agent")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";

  ensureAllowedProvider(cleaned);
  return cleaned;
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

function normalizeAgentTarget(input: JsonRecord = {}) {
  const provider = cleanProvider(input.provider || input.agent);
  const workspace = normalizeWorkspace(
    input.workspace || input.workspacePath || input.project || process.env.AGENT_WORKSPACE || PROJECT_ROOT,
  );
  const sessionHint = sanitizeText(
    input.sessionHint || input.session || input.chat || input.thread || input.route || "",
    "Session hint",
    MAX_ROUTE_CHARS,
  );
  const mode = TARGET_MODES.has(input.mode) ? input.mode : input.new ? "new" : "existing";
  const deliveryMode = TARGET_DELIVERY_MODES.has(input.deliveryMode) ? input.deliveryMode : undefined;
  const route = sanitizeText(input.route || input.label || sessionHint || mode, "Route", MAX_ROUTE_CHARS);
  const label = sanitizeText(input.label || `${titleCase(provider)} / ${route}`, "Label", MAX_LABEL_CHARS);
  const id = sanitizeText(
    input.id || `${provider}:${slugify(workspace)}:${slugify(sessionHint || route || mode)}`,
    "Target id",
    MAX_ID_CHARS,
  );

  return {
    id,
    provider,
    label,
    workspace,
    sessionHint,
    mode,
    deliveryMode,
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

async function readAgentState() {
  return readJsonFile(AGENT_STATE_PATH, {});
}

async function updateAgentState(update) {
  const state = await readAgentState();
  const nextState = {
    ...state,
    ...update,
  };

  await writeJsonFile(AGENT_STATE_PATH, nextState);
  return nextState;
}

async function getActiveTarget() {
  const state = await readAgentState();
  return normalizeAgentTarget(state.activeTarget || defaultAgentTarget());
}

async function setActiveTarget(target) {
  const activeTarget = {
    ...normalizeAgentTarget(target),
    configuredAt: new Date().toISOString(),
  };

  await updateAgentState({ activeTarget });
  return activeTarget;
}

function normalizeReplyPreferences(input: JsonRecord = {}) {
  const enabled = input.enabled !== false;
  const requestedMaxWords = Number(input.maxWords || input.max_words || DEFAULT_CONCISE_REPLY_WORDS);
  const maxWords =
    Number.isFinite(requestedMaxWords) && requestedMaxWords >= 8 && requestedMaxWords <= 80
      ? Math.round(requestedMaxWords)
      : DEFAULT_CONCISE_REPLY_WORDS;
  const mode = REPLY_MODES.has(input.mode) ? input.mode : enabled ? "concise" : "normal";

  return compactRecord({
    mode,
    enabled: mode === "concise",
    ui: input.ui === undefined ? mode === "concise" : Boolean(input.ui),
    maxWords,
    cadence: sanitizeText(input.cadence || "meaningful milestones", "Reply cadence", MAX_REPLY_NOTE_CHARS),
    note: sanitizeText(input.note || "", "Reply note", MAX_REPLY_NOTE_CHARS),
    source: sanitizeText(input.source || "mcp", "Reply preference source", MAX_LABEL_CHARS),
    updatedAt: new Date().toISOString(),
  });
}

async function getReplyPreferences() {
  const state = await readAgentState();
  return state.replyPreferences || normalizeReplyPreferences({ enabled: false });
}

async function setReplyPreferences(preferences: JsonRecord = {}) {
  const replyPreferences = normalizeReplyPreferences(preferences);
  await updateAgentState({ replyPreferences });
  return replyPreferences;
}

function compactRecord(record: JsonRecord) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== ""));
}

function displayText(value, maxChars = MAX_THREAD_MESSAGE_CHARS) {
  const text = String(value || "").replace(/\0/g, "").trim();

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars - FEED_TRUNCATION_SUFFIX.length).trimEnd()}${FEED_TRUNCATION_SUFFIX}`;
}

function normalizeThreadMessageType(type) {
  return THREAD_MESSAGE_TYPES.has(type) ? type : "agent";
}

function cleanDispatchStatus(status) {
  return ["queued", "sent"].includes(status) ? status : undefined;
}

function normalizeThreadMessage(message: JsonRecord = {}) {
  const text = displayText(message.text);

  if (!text) {
    return null;
  }

  return compactRecord({
    id: String(message.id || crypto.randomUUID()).slice(0, MAX_ID_CHARS),
    receivedAt: message.receivedAt || new Date().toISOString(),
    type: normalizeThreadMessageType(message.type),
    text,
    dispatchStatus: cleanDispatchStatus(message.dispatchStatus),
    dispatchLabel: displayText(message.dispatchLabel, MAX_LABEL_CHARS),
  });
}

function commandThreadMessage(command: JsonRecord = {}) {
  const queued = command.status === "queued";

  return normalizeThreadMessage({
    id: command.id ? `command:${command.id}` : undefined,
    receivedAt: command.receivedAt,
    type: "user",
    text: command.userText || command.text,
    dispatchStatus: queued ? "queued" : "sent",
    dispatchLabel: queued ? "Queued for agent" : "Sent to agent",
  });
}

function eventThreadMessage(event: JsonRecord = {}) {
  return normalizeThreadMessage({
    id: event.id ? `event:${event.id}` : undefined,
    receivedAt: event.receivedAt,
    type: ["warning", "error"].includes(event.level) ? "warning" : "agent",
    text: event.text,
  });
}

function lineRecordId(line) {
  try {
    return String(JSON.parse(line).id || "");
  } catch {
    return "";
  }
}

function trimJsonlLinesToBytes(lines: string[], maxBytes: number) {
  const kept = [];
  let size = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const lineSize = Buffer.byteLength(`${line}\n`);

    if (kept.length && size + lineSize > maxBytes) {
      break;
    }

    kept.push(line);
    size += lineSize;
  }

  return kept.reverse();
}

async function writeRollingJsonl(filePath: string, record: JsonRecord, maxBytes: number) {
  await ensureLocalDir(filePath);

  let lines = [];

  try {
    lines = (await fsp.readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const recordId = String(record.id || "");
  const nextLine = JSON.stringify(record);
  const nextLines = recordId ? lines.filter((line) => lineRecordId(line) !== recordId) : lines;
  const kept = trimJsonlLinesToBytes([...nextLines, nextLine], maxBytes);

  await fsp.writeFile(filePath, `${kept.join("\n")}\n`, "utf8");
}

async function appendThreadMessage(target: JsonRecord | string = {}, message: JsonRecord = {}) {
  const threadKey = threadLogKeyFromTarget(target);

  if (!threadKey) {
    return null;
  }

  const record = normalizeThreadMessage(message);

  if (!record) {
    return null;
  }

  await writeRollingJsonl(threadLogPath(threadKey), record, MAX_THREAD_LOG_BYTES);
  return record;
}

async function appendThreadCommandMessage(command: JsonRecord = {}) {
  const message = commandThreadMessage(command);

  if (!message) {
    return null;
  }

  return appendThreadMessage(command.target, message);
}

async function findCommandTarget(commandId) {
  const id = String(commandId || "").trim();

  if (!id) {
    return undefined;
  }

  try {
    const file = await fsp.readFile(AGENT_COMMANDS_PATH, "utf8");
    const lines = file.split(/\r?\n/).filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const command = JSON.parse(lines[index]);

        if (command.id === id) {
          return command.target;
        }
      } catch {
        // Ignore corrupt command rows; the normal event reader reports parse errors.
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  return undefined;
}

function normalizeStoredThreadMessage(record: JsonRecord = {}) {
  const message = normalizeThreadMessage(record);

  if (!message) {
    return null;
  }

  return {
    ...message,
    id: String(record.id || message.id),
  };
}

async function readThreadMessages(targetOrThreadId: JsonRecord | string = {}, options: JsonRecord = {}) {
  const threadKey = threadLogKeyFromTarget(targetOrThreadId);
  const limit = Math.max(1, Math.min(Number(options.limit || THREAD_CONTEXT_MESSAGE_LIMIT), 20));

  if (!threadKey) {
    return [];
  }

  try {
    const file = await fsp.readFile(threadLogPath(threadKey), "utf8");
    const records = [];

    for (const line of file.split(/\r?\n/).filter(Boolean)) {
      try {
        const record = normalizeStoredThreadMessage(JSON.parse(line));

        if (record) {
          records.push(record);
        }
      } catch {
        // Thread context is best-effort; skip malformed rows in the compact log.
      }
    }

    return records.slice(-limit);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function appendCommand(command: JsonRecord) {
  const text = sanitizeText(command.text, "Command text", MAX_COMMAND_TEXT_CHARS);
  const userText = sanitizeText(command.userText, "User text", MAX_COMMAND_TEXT_CHARS);

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
    userText: userText && userText !== text ? userText : undefined,
    text,
  });

  await ensureLocalDir(AGENT_COMMANDS_PATH);
  await fsp.appendFile(AGENT_COMMANDS_PATH, `${JSON.stringify(record)}\n`, "utf8");
  await appendThreadCommandMessage(record).catch(() => {});
  return record;
}

async function appendEvent(event: JsonRecord) {
  const text = sanitizeText(event.text, "Event text", MAX_EVENT_TEXT_CHARS);

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
  await appendThreadMessage(
    record.target || (record.commandId ? await findCommandTarget(record.commandId) : undefined),
    eventThreadMessage(record) || {},
  ).catch(() => {});
  return record;
}

async function readJsonl(filePath: string, options: JsonRecord = {}) {
  const afterOption = String(options.after || "").toLowerCase();
  const parsedAfter = Number(options.after || 0);
  const after =
    afterOption === "latest"
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Number.isFinite(parsedAfter) ? parsedAfter : 0);
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
  appendThreadCommandMessage,
  appendThreadMessage,
  defaultAgentTarget,
  getActiveTarget,
  getReplyPreferences,
  isWorkspaceAllowed,
  normalizeAgentTarget,
  paths: {
    allowedWorkspaceRoots: ALLOWED_WORKSPACE_ROOTS,
    commands: AGENT_COMMANDS_PATH,
    events: AGENT_EVENTS_PATH,
    state: AGENT_STATE_PATH,
    threadLogs: AGENT_THREAD_LOG_DIR,
  },
  readCommands,
  readEvents,
  readThreadMessages,
  setActiveTarget,
  setReplyPreferences,
};
