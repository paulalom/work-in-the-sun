const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const GLOBAL_STATE_PATH = path.join(CODEX_HOME, ".codex-global-state.json");
const SESSION_INDEX_PATH = path.join(CODEX_HOME, "session_index.jsonl");
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

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

function projectLabel(root, labels = {}) {
  const configuredLabel = labels[root];

  if (configuredLabel) {
    return /[\s_-]/.test(configuredLabel) ? humanizeName(configuredLabel) : configuredLabel;
  }

  return humanizeName(path.basename(root)) || root;
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

async function readCodexState() {
  return readJsonFile(GLOBAL_STATE_PATH, {});
}

async function listProjects(options = {}) {
  const state = await readCodexState();
  const labels = state["electron-workspace-root-labels"] || {};
  const projects = uniqueRoots(state).map((root) => ({
    id: root,
    label: projectLabel(root, labels),
    workspace: root,
  }));
  const { after, limit } = pageOptions(options);
  const selected = projects.slice(after, after + limit);

  return {
    cursor: after + selected.length,
    total: projects.length,
    projects: selected,
  };
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

async function listChats(options = {}) {
  const [state, sessions] = await Promise.all([readCodexState(), readSessions()]);
  const labels = state["electron-workspace-root-labels"] || {};
  const workspaceHints = state["thread-workspace-root-hints"] || {};
  const sorted = sessions
    .map((session) => ({
      id: session.id,
      label: String(session.thread_name || session.id).trim(),
      updatedAt: session.updated_at || "",
      updatedMs: Date.parse(session.updated_at || "") || 0,
      workspace: workspaceHints[session.id] || "",
    }))
    .sort((a, b) => b.updatedMs - a.updatedMs || a.label.localeCompare(b.label));
  const { after, limit } = pageOptions(options);
  const selected = sorted.slice(after, after + limit).map((session) => ({
    id: session.id,
    label: session.label,
    updatedAt: session.updatedAt,
    workspace: session.workspace,
    projectLabel: session.workspace ? projectLabel(session.workspace, labels) : "",
  }));

  return {
    cursor: after + selected.length,
    total: sorted.length,
    chats: selected,
  };
}

module.exports = {
  listChats,
  listProjects,
  paths: {
    codexHome: CODEX_HOME,
    globalState: GLOBAL_STATE_PATH,
    sessionIndex: SESSION_INDEX_PATH,
  },
};
