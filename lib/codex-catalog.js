const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const GLOBAL_STATE_PATH = path.join(CODEX_HOME, ".codex-global-state.json");
const SESSION_INDEX_PATH = path.join(CODEX_HOME, "session_index.jsonl");
const SESSION_ROOTS = [path.join(CODEX_HOME, "sessions"), path.join(CODEX_HOME, "archived_sessions")];
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

function projectLabel(root, labels = {}) {
  const configuredLabel = labels[root];

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

function codexProjects(state) {
  const labels = state["electron-workspace-root-labels"] || {};
  return uniqueRoots(state).map((root) => projectRecord(root, labels));
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
  const projects = codexProjects(state);
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
  const projects = codexProjects(state);
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

  if (project) {
    sorted = await enrichSessionWorkspaces(sorted, { refresh: true });
    sorted = sorted.filter((session) => sameOrChildWorkspace(session.workspace, project.workspace));
  }

  const { after, limit } = pageOptions(options);
  const selected = await enrichSessionWorkspaces(sorted.slice(after, after + limit), { refresh: true });
  const chats = selected.map((session) => ({
    id: session.id,
    label: session.label,
    updatedAt: session.updatedAt,
    workspace: session.workspace,
    projectLabel: session.workspace ? projectLabel(session.workspace, labels) : "",
  }));

  return {
    cursor: after + selected.length,
    total: sorted.length,
    project,
    projectMissing: false,
    chats,
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
