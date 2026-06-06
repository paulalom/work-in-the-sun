const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const agentStore = require("./agent-store");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const GLOBAL_STATE_PATH = path.join(CODEX_HOME, ".codex-global-state.json");
const SESSION_INDEX_PATH = path.join(CODEX_HOME, "session_index.jsonl");
const SESSION_ROOTS = [path.join(CODEX_HOME, "sessions"), path.join(CODEX_HOME, "archived_sessions")];
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
const MAX_THREAD_NAME_CHARS = finiteNumber(process.env.WITS_MAX_THREAD_NAME_CHARS, 120);
const RECENT_ACTIVITY_LIMIT = finiteNumber(process.env.WITS_THREAD_ACTIVITY_RECORDS, 500);
const BUSY_STALE_MS = finiteNumber(process.env.WITS_THREAD_BUSY_STALE_MS, 6 * 60 * 60 * 1000);
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TERMINAL_EVENT_LEVELS = new Set(["result", "error"]);
const PROJECT_INDICATOR_FILES = new Set([
  ".git",
  "agents.md",
  "cargo.toml",
  "gemfile",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "deno.json",
  "deno.jsonc",
  "go.mod",
  "mix.exs",
  "package.json",
  "pom.xml",
  "pyproject.toml",
]);
const IGNORED_PROJECT_DIRS = new Set([
  ".cache",
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  ".venv",
  "build",
  "dist",
  "node_modules",
  "out",
  "temp",
  "tmp",
  "vendor",
  "venv",
]);

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to"]);
const ACRONYMS = new Set(["ai", "api", "mcp", "rl", "rts", "tts", "ui", "ux"]);

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

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pageOptions(options = {}) {
  const after = finiteNumber(options.after, 0);
  const limit = finiteNumber(options.limit, DEFAULT_LIMIT);

  return {
    after: Math.max(0, after),
    limit: Math.max(1, Math.min(limit, MAX_LIMIT)),
  };
}

function humanizeName(name) {
  const words = String(name || "")
    .replace(/\.[^.]+$/, "")
    .split(/[\s_-]+/)
    .filter(Boolean);

  if (!words.length) {
    return "";
  }

  return words
    .map((word, index) => {
      const lower = word.toLowerCase();

      if (ACRONYMS.has(lower)) {
        return lower.toUpperCase();
      }

      if (index > 0 && SMALL_WORDS.has(lower)) {
        return lower;
      }

      return `${lower[0]?.toUpperCase() || ""}${lower.slice(1)}`;
    })
    .join(" ");
}

function normalizeSearchText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]:\\/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactSearchText(text) {
  return normalizeSearchText(text).replace(/\s+/g, "");
}

function normalizedThreadTitle(text) {
  return normalizeSearchText(text);
}

function cleanThreadName(value) {
  const name = String(value || "")
    .replace(/\0/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) {
    throw new Error("Missing thread name.");
  }

  if (name.length > MAX_THREAD_NAME_CHARS) {
    throw new Error(`Thread name must be ${MAX_THREAD_NAME_CHARS} characters or fewer.`);
  }

  return name;
}

function recordMs(record) {
  return Date.parse(record?.receivedAt || record?.updatedAt || "") || 0;
}

function extractThreadId(target = {}) {
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

function targetTitleCandidates(target = {}) {
  const values = [target.route, target.sessionHint, target.label]
    .filter(Boolean)
    .map(String)
    .filter((value) => !/^current$/i.test(value.trim()));
  const expanded = [];

  for (const value of values) {
    expanded.push(value);

    const parts = value.split(/\s*\/\s*/).filter(Boolean);

    if (parts.length > 1) {
      expanded.push(parts.at(-1));
    }
  }

  return [...new Set(expanded.map(normalizedThreadTitle).filter(Boolean))];
}

async function readRecentRecords(readRecords, limit = RECENT_ACTIVITY_LIMIT) {
  const latest = await readRecords({ after: "latest", limit: 1 });
  const total = Number(latest.total || latest.cursor || 0);

  if (!total) {
    return [];
  }

  const after = Math.max(0, total - Math.max(1, limit));
  const result = await readRecords({ after, limit });
  return result.records || [];
}

function busyCommandsBefore(commands, beforeMs) {
  return [...commands.values()]
    .filter((command) => command.busy && command.receivedMs <= beforeMs)
    .sort((a, b) => a.receivedMs - b.receivedMs);
}

function applyActivityEvent(activity, threadId, event, options = {}) {
  if (!threadId) {
    return;
  }

  const eventMs = recordMs(event);
  const current = activity.get(threadId) || {
    busy: false,
    lastActivityMs: 0,
    lastCommandMs: 0,
    lastCommandId: "",
  };
  const terminal = TERMINAL_EVENT_LEVELS.has(event.level);
  const appliesToCurrentCommand =
    !options.commandId ||
    !current.lastCommandId ||
    current.lastCommandId === options.commandId ||
    current.lastCommandMs <= (options.commandMs || eventMs);

  activity.set(threadId, {
    ...current,
    busy: terminal && appliesToCurrentCommand ? false : current.busy || event.level === "progress",
    lastEventAt: event.receivedAt || current.lastEventAt,
    lastActivityMs: Math.max(current.lastActivityMs, eventMs),
  });
}

async function threadActivityIndex() {
  const [commands, events] = await Promise.all([
    readRecentRecords(agentStore.readCommands),
    readRecentRecords(agentStore.readEvents),
  ]);
  const activity = new Map();
  const commandIndex = new Map();
  const records = [
    ...commands.map((record) => ({ kind: "command", record, receivedMs: recordMs(record) })),
    ...events.map((record) => ({ kind: "event", record, receivedMs: recordMs(record) })),
  ].sort((a, b) => a.receivedMs - b.receivedMs);

  for (const item of records) {
    if (item.kind === "command") {
      const command = item.record;
      const threadId = extractThreadId(command.target);

      if (!threadId) {
        continue;
      }

      const commandState = {
        id: command.id,
        threadId,
        busy: true,
        receivedMs: item.receivedMs,
      };
      commandIndex.set(command.id, commandState);
      activity.set(threadId, {
        ...(activity.get(threadId) || {}),
        busy: true,
        lastCommandAt: command.receivedAt,
        lastCommandId: command.id,
        lastCommandMs: item.receivedMs,
        lastActivityMs: Math.max(activity.get(threadId)?.lastActivityMs || 0, item.receivedMs),
      });
      continue;
    }

    const event = item.record;
    const terminal = TERMINAL_EVENT_LEVELS.has(event.level);
    const command = event.commandId ? commandIndex.get(event.commandId) : null;
    const targetThreadId = extractThreadId(event.target);

    if (command) {
      applyActivityEvent(activity, command.threadId, event, {
        commandId: command.id,
        commandMs: command.receivedMs,
      });

      if (terminal) {
        command.busy = false;
      }

      continue;
    }

    if (targetThreadId) {
      applyActivityEvent(activity, targetThreadId, event);
      continue;
    }

    if (terminal) {
      const openCommands = busyCommandsBefore(commandIndex, item.receivedMs);

      for (const openCommand of openCommands) {
        applyActivityEvent(activity, openCommand.threadId, event, {
          commandId: openCommand.id,
          commandMs: openCommand.receivedMs,
        });
        openCommand.busy = false;
      }
    }
  }

  if (BUSY_STALE_MS > 0) {
    const staleBefore = Date.now() - BUSY_STALE_MS;

    for (const [threadId, item] of activity) {
      if (item.busy && item.lastActivityMs < staleBefore) {
        activity.set(threadId, {
          ...item,
          busy: false,
          stale: true,
        });
      }
    }
  }

  return activity;
}

function configuredProjectLabel(root, labels = {}) {
  const directLabel = labels[root] || labels[path.resolve(root)];

  if (directLabel) {
    return directLabel;
  }

  const normalizedRoot = path.resolve(root).toLowerCase();
  return Object.entries(labels).find(([labelRoot]) => path.resolve(labelRoot).toLowerCase() === normalizedRoot)?.[1];
}

function projectLabel(root, labels = {}) {
  const configuredLabel = configuredProjectLabel(root, labels);

  if (configuredLabel) {
    return /[\s_-]/.test(configuredLabel) ? humanizeName(configuredLabel) : configuredLabel;
  }

  return humanizeName(path.basename(root)) || root;
}

function projectRecord(root, labels = {}) {
  return {
    id: root,
    label: projectLabel(root, labels),
    workspace: root,
  };
}

function uniqueRoots(state) {
  const sources = [
    state["project-order"],
    state["active-workspace-roots"],
    state["electron-saved-workspace-roots"],
    state["pinned-project-ids"],
  ];
  const seen = new Set();
  const roots = [];

  for (const source of sources) {
    for (const root of Array.isArray(source) ? source : []) {
      if (typeof root !== "string" || !root.trim()) {
        continue;
      }

      const key = root.toLowerCase();

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      roots.push(root);
    }
  }

  return roots;
}

function addProjectRoot(roots, seen, root) {
  const resolved = path.resolve(root);
  const key = resolved.toLowerCase();

  if (seen.has(key) || !agentStore.isWorkspaceAllowed(resolved)) {
    return;
  }

  seen.add(key);
  roots.push(resolved);
}

function shouldSkipWorkspaceChild(entry) {
  return (
    !entry.isDirectory() ||
    entry.name.startsWith(".") ||
    IGNORED_PROJECT_DIRS.has(entry.name.toLowerCase())
  );
}

async function hasProjectIndicator(root) {
  let entries;

  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return false;
    }

    throw error;
  }

  return entries.some((entry) => {
    const name = entry.name.toLowerCase();

    if (name === ".git") {
      return entry.isDirectory() || entry.isFile();
    }

    return entry.isFile() && PROJECT_INDICATOR_FILES.has(name);
  });
}

async function discoverWorkspaceProjects() {
  const roots = [];
  const seen = new Set();

  for (const allowedRoot of agentStore.paths.allowedWorkspaceRoots) {
    if (await hasProjectIndicator(allowedRoot)) {
      addProjectRoot(roots, seen, allowedRoot);
    }

    let entries;

    try {
      entries = await fsp.readdir(allowedRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        continue;
      }

      throw error;
    }

    const childDirectories = entries
      .filter((entry) => !shouldSkipWorkspaceChild(entry))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of childDirectories) {
      const childRoot = path.join(allowedRoot, entry.name);

      if (await hasProjectIndicator(childRoot)) {
        addProjectRoot(roots, seen, childRoot);
      }
    }
  }

  return roots;
}

async function codexProjects(state) {
  const labels = state["electron-workspace-root-labels"] || {};
  const roots = [];
  const seen = new Set();

  for (const root of uniqueRoots(state)) {
    addProjectRoot(roots, seen, root);
  }

  for (const root of await discoverWorkspaceProjects()) {
    addProjectRoot(roots, seen, root);
  }

  return roots.map((root) => projectRecord(root, labels));
}

function matchProject(projects, query) {
  const normalizedQuery = normalizeSearchText(query);
  const compactQuery = compactSearchText(query);

  if (!normalizedQuery) {
    return null;
  }

  const candidates = projects.map((project) => {
    const names = [
      project.label,
      path.basename(project.workspace),
      project.workspace,
      project.workspace.replace(/\\/g, "/"),
    ];
    const normalizedNames = names.map(normalizeSearchText).filter(Boolean);
    const compactNames = names.map(compactSearchText).filter(Boolean);

    return {
      project,
      normalizedNames,
      compactNames,
    };
  });

  return (
    candidates.find((candidate) => candidate.normalizedNames.includes(normalizedQuery))?.project ||
    candidates.find((candidate) => candidate.compactNames.includes(compactQuery))?.project ||
    candidates.find((candidate) =>
      candidate.normalizedNames.some((name) => name.includes(normalizedQuery) || normalizedQuery.includes(name)),
    )?.project ||
    null
  );
}

async function readCodexState() {
  return readJsonFile(GLOBAL_STATE_PATH, {});
}

async function listProjects(options = {}) {
  const state = await readCodexState();
  const projects = await codexProjects(state);
  const { after, limit } = pageOptions(options);
  const selected = projects.slice(after, after + limit);

  return {
    cursor: after + selected.length,
    total: projects.length,
    projects: selected,
  };
}

async function resolveProject(query) {
  const state = await readCodexState();
  return matchProject(await codexProjects(state), query);
}

function parseSessionLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function readSessions() {
  try {
    const file = await fsp.readFile(SESSION_INDEX_PATH, "utf8");
    return file
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseSessionLine)
      .filter((session) => session?.id);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function readSessionIndexLines() {
  const file = await fsp.readFile(SESSION_INDEX_PATH, "utf8");
  const hasTrailingNewline = /\r?\n$/.test(file);
  const lines = file.split(/\r?\n/);

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return { lines, hasTrailingNewline };
}

function findSessionLine(lines, target = {}) {
  const threadId = extractThreadId(target);
  const candidates = targetTitleCandidates(target);
  const titleMatches = [];

  for (let index = 0; index < lines.length; index += 1) {
    const session = parseSessionLine(lines[index]);

    if (!session?.id) {
      continue;
    }

    if (threadId && session.id === threadId) {
      return { index, session };
    }

    if (!threadId && candidates.includes(normalizedThreadTitle(session.thread_name || session.id))) {
      titleMatches.push({ index, session });
    }
  }

  if (threadId) {
    throw new Error("Current Codex thread was not found.");
  }

  if (!candidates.length) {
    throw new Error("Current Codex target does not identify a thread.");
  }

  if (titleMatches.length === 1) {
    return titleMatches[0];
  }

  if (titleMatches.length > 1) {
    throw new Error("More than one Codex thread matched the current target.");
  }

  throw new Error("Current Codex thread was not found.");
}

async function writeSessionIndexLines(lines, hasTrailingNewline) {
  const text = `${lines.join("\n")}${hasTrailingNewline ? "\n" : ""}`;
  const tempPath = `${SESSION_INDEX_PATH}.${process.pid}.${Date.now()}.tmp`;

  await fsp.writeFile(tempPath, text, "utf8");
  await fsp.rename(tempPath, SESSION_INDEX_PATH);
}

async function listJsonlFiles(root) {
  let entries;

  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);

      if (entry.isDirectory()) {
        return listJsonlFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".jsonl") ? [entryPath] : [];
    }),
  );

  return files.flat();
}

async function sessionFileIndex() {
  const files = (await Promise.all(SESSION_ROOTS.map(listJsonlFiles))).flat();
  const index = new Map();

  for (const file of files) {
    const match = path.basename(file).match(/([0-9a-f-]{36})\.jsonl$/i);

    if (match) {
      index.set(match[1], file);
    }
  }

  return index;
}

function readFirstLine(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    let buffer = "";

    stream.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex >= 0) {
        stream.destroy();
        resolve(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
      }
    });
    stream.on("end", () => resolve(buffer));
    stream.on("error", reject);
  });
}

async function readSessionMetaWorkspace(filePath) {
  try {
    const line = await readFirstLine(filePath);
    const record = JSON.parse(line);
    return String(record.payload?.cwd || "").trim();
  } catch {
    return "";
  }
}

async function enrichSessionWorkspaces(sessions, options = {}) {
  const targets = options.refresh ? sessions : sessions.filter((session) => !session.workspace);

  if (!targets.length) {
    return sessions;
  }

  const files = await sessionFileIndex();
  await Promise.all(
    targets.map(async (session) => {
      const file = files.get(session.id);

      if (file) {
        session.workspace = (await readSessionMetaWorkspace(file)) || session.workspace;
      }
    }),
  );

  return sessions;
}

function sameOrChildWorkspace(workspace, projectWorkspace) {
  if (!workspace || !projectWorkspace) {
    return false;
  }

  const normalizedWorkspace = path.resolve(workspace || "").toLowerCase();
  const normalizedProject = path.resolve(projectWorkspace || "").toLowerCase();

  return (
    normalizedWorkspace === normalizedProject ||
    normalizedWorkspace.startsWith(`${normalizedProject}${path.sep}`)
  );
}

async function listChats(options = {}) {
  const [state, sessions] = await Promise.all([readCodexState(), readSessions()]);
  const labels = state["electron-workspace-root-labels"] || {};
  const workspaceHints = state["thread-workspace-root-hints"] || {};
  const projects = await codexProjects(state);
  const project = matchProject(projects, options.project || options.projectQuery);

  if ((options.project || options.projectQuery) && !project) {
    return {
      cursor: 0,
      total: 0,
      project: null,
      projectMissing: true,
      projectQuery: String(options.project || options.projectQuery),
      chats: [],
    };
  }

  let sorted = sessions
    .map((session) => ({
      id: session.id,
      label: String(session.thread_name || session.id).trim(),
      updatedAt: session.updated_at || "",
      updatedMs: Date.parse(session.updated_at || "") || 0,
      workspace: workspaceHints[session.id] || "",
    }))
    .sort((a, b) => b.updatedMs - a.updatedMs || a.label.localeCompare(b.label));

  sorted = await enrichSessionWorkspaces(sorted, { refresh: false });
  sorted = sorted.filter((session) => session.workspace && agentStore.isWorkspaceAllowed(session.workspace));

  if (project) {
    sorted = await enrichSessionWorkspaces(sorted, { refresh: true });
    sorted = sorted.filter((session) => sameOrChildWorkspace(session.workspace, project.workspace));
  }

  const { after, limit } = pageOptions(options);
  const selected = await enrichSessionWorkspaces(sorted.slice(after, after + limit), { refresh: true });
  const activity = await threadActivityIndex();
  const chats = selected.map((session) => ({
    id: session.id,
    label: session.label,
    updatedAt: session.updatedAt,
    workspace: session.workspace,
    projectLabel: session.workspace ? projectLabel(session.workspace, labels) : "",
    busy: Boolean(activity.get(session.id)?.busy),
    lastCommandAt: activity.get(session.id)?.lastCommandAt,
    lastEventAt: activity.get(session.id)?.lastEventAt,
  }));

  return {
    cursor: after + selected.length,
    total: sorted.length,
    project,
    projectMissing: false,
    chats,
  };
}

async function renameChat(target = {}, name) {
  const threadName = cleanThreadName(name);
  const { lines, hasTrailingNewline } = await readSessionIndexLines();
  const { index, session } = findSessionLine(lines, target);
  const nextSession = {
    ...session,
    thread_name: threadName,
  };

  lines[index] = JSON.stringify(nextSession);
  await writeSessionIndexLines(lines, hasTrailingNewline);

  const state = await readCodexState();
  const labels = state["electron-workspace-root-labels"] || {};
  const workspaceHints = state["thread-workspace-root-hints"] || {};
  const [enriched] = await enrichSessionWorkspaces(
    [
      {
        id: session.id,
        label: threadName,
        updatedAt: session.updated_at || "",
        updatedMs: Date.parse(session.updated_at || "") || 0,
        workspace: workspaceHints[session.id] || "",
      },
    ],
    { refresh: true },
  );
  const workspace = enriched?.workspace || "";

  return {
    id: session.id,
    label: threadName,
    updatedAt: session.updated_at || "",
    workspace,
    projectLabel: workspace ? projectLabel(workspace, labels) : "",
  };
}

module.exports = {
  listChats,
  listProjects,
  renameChat,
  resolveProject,
  paths: {
    codexHome: CODEX_HOME,
    globalState: GLOBAL_STATE_PATH,
    sessionIndex: SESSION_INDEX_PATH,
  },
};
