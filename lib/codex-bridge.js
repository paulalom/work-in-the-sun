const { spawn } = require("child_process");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const agentStore = require("./agent-store");

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DIRECT_SEND_ENABLED = !["0", "false", "off"].includes(
  String(process.env.CODEX_DIRECT_SEND || "1").toLowerCase(),
);
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_APP_SERVER_REQUEST_TIMEOUT_MS || 60_000);
const TURN_TIMEOUT_MS = Number(process.env.CODEX_DIRECT_TURN_TIMEOUT_MS || 30 * 60_000);

let dispatchChain = Promise.resolve();
let codexCliPromise = null;

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function isCodexTarget(target = {}) {
  return String(target.provider || "").toLowerCase() === "codex";
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

function dispatchRoute(command) {
  const target = command.target || {};

  if (!DIRECT_SEND_ENABLED) {
    return { accepted: false, reason: "disabled" };
  }

  if (!isCodexTarget(target)) {
    return { accepted: false, reason: "not-codex" };
  }

  if (target.mode === "new") {
    return { accepted: true, mode: "new" };
  }

  const threadId = extractThreadId(target);

  if (!threadId) {
    return { accepted: false, reason: "missing-thread-id" };
  }

  return { accepted: true, mode: "existing", threadId };
}

async function isFile(filePath) {
  try {
    return (await fsp.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function findLatestWindowsCodexCli() {
  const root = path.join(os.homedir(), "AppData", "Local", "OpenAI", "Codex", "bin");
  let entries;

  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return "";
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const cli = path.join(root, entry.name, "codex.exe");

        if (!(await isFile(cli))) {
          return null;
        }

        const stat = await fsp.stat(cli);
        return { cli, mtimeMs: stat.mtimeMs };
      }),
  );

  return candidates
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.cli || "";
}

async function findCodexCli() {
  if (codexCliPromise) {
    return codexCliPromise;
  }

  codexCliPromise = (async () => {
    const configured = process.env.CODEX_CLI_PATH || process.env.CODEX_PATH || "";

    if (configured) {
      return configured;
    }

    if (process.platform === "win32") {
      const discovered = await findLatestWindowsCodexCli();

      if (discovered) {
        return discovered;
      }
    }

    return "codex";
  })();

  return codexCliPromise;
}

function textInput(text) {
  return {
    type: "text",
    text,
  };
}

function targetForThread(command, threadId, previousTarget) {
  return {
    ...previousTarget,
    id: `codex:${threadId}`,
    provider: "codex",
    sessionHint: threadId,
    mode: "existing",
    route: previousTarget.route || previousTarget.label || threadId,
    workspace: previousTarget.workspace,
    label: previousTarget.label || `Codex / ${threadId}`,
  };
}

async function appendBridgeEvent(command, event) {
  await agentStore.appendEvent({
    source: "codex-bridge",
    commandId: command.id,
    target: command.target,
    ...event,
  });
}

class CodexAppServerClient {
  constructor(command) {
    this.command = command;
    this.buffer = "";
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.turnWaiters = new Map();
    this.completedTurns = new Map();
    this.agentMessages = new Map();
    this.stderr = "";
  }

  async start() {
    const cli = await findCodexCli();
    this.child = spawn(cli, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      if (this.pending.size || this.turnWaiters.size) {
        const detail = this.stderr.trim();
        this.rejectAll(new Error(detail || `Codex app-server exited with code ${code}.`));
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: "work-in-the-sun",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
  }

  close() {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }

  notify(method, params) {
    this.write(compact({ method, params }));
  }

  request(method, params, options = {}) {
    const id = this.nextId;
    this.nextId += 1;

    const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
    const message = compact({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.write(message);
    });
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";

    lines
      .filter((line) => line.trim())
      .forEach((line) => this.handleLine(line));
  }

  handleLine(line) {
    let message;

    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message || `Codex app-server ${pending.method} failed.`));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message).catch(() => {
        this.write({
          id: message.id,
          error: {
            code: -32603,
            message: "Work in the Sun could not handle the Codex request.",
          },
        });
      });
      return;
    }

    if (message.method) {
      this.handleNotification(message).catch(() => {});
    }
  }

  async handleServerRequest(message) {
    const method = message.method;

    if (method === "item/commandExecution/requestApproval") {
      await appendBridgeEvent(this.command, {
        level: "warning",
        text: "Codex asked for command approval. The phone bridge cancelled the request because remote approval is not wired yet.",
      });
      this.write({ id: message.id, result: { decision: "cancel" } });
      return;
    }

    if (method === "item/fileChange/requestApproval") {
      await appendBridgeEvent(this.command, {
        level: "warning",
        text: "Codex asked for file change approval. The phone bridge cancelled the request because remote approval is not wired yet.",
      });
      this.write({ id: message.id, result: { decision: "cancel" } });
      return;
    }

    this.write({
      id: message.id,
      error: {
        code: -32601,
        message: `Work in the Sun cannot handle Codex server request: ${method}`,
      },
    });
  }

  async handleNotification(message) {
    const params = message.params || {};

    switch (message.method) {
      case "turn/started":
        await appendBridgeEvent(this.command, {
          level: "progress",
          text: "Codex started working on the command.",
          speak: false,
        });
        return;

      case "item/agentMessage/delta": {
        const current = this.agentMessages.get(params.itemId) || "";
        this.agentMessages.set(params.itemId, current + (params.delta || ""));
        return;
      }

      case "item/completed":
        await this.handleCompletedItem(params.item || {});
        return;

      case "turn/completed":
        this.completedTurns.set(params.turn?.id, params.turn);
        this.resolveTurn(params.turn?.id, params.turn);
        return;

      case "error":
        await appendBridgeEvent(this.command, {
          level: params.willRetry ? "warning" : "error",
          text: params.error?.message || "Codex reported an error.",
        });
        return;

      default:
        return;
    }
  }

  async handleCompletedItem(item) {
    if (item.type !== "agentMessage") {
      return;
    }

    const text = String(item.text || this.agentMessages.get(item.id) || "").trim();

    if (!text) {
      return;
    }

    await appendBridgeEvent(this.command, {
      level: item.phase === "final_answer" ? "result" : "progress",
      text,
    });
  }

  waitForTurn(turnId) {
    if (this.completedTurns.has(turnId)) {
      return Promise.resolve(this.completedTurns.get(turnId));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error("Codex turn timed out."));
      }, TURN_TIMEOUT_MS);

      this.turnWaiters.set(turnId, {
        resolve: (turn) => {
          clearTimeout(timeout);
          resolve(turn);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  resolveTurn(turnId, turn) {
    const waiter = this.turnWaiters.get(turnId);

    if (!waiter) {
      return;
    }

    this.turnWaiters.delete(turnId);
    waiter.resolve(turn);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    for (const waiter of this.turnWaiters.values()) {
      waiter.reject(error);
    }

    this.pending.clear();
    this.turnWaiters.clear();
  }
}

async function resolveThread(client, command, route) {
  const target = command.target || {};

  if (route.mode === "new") {
    const result = await client.request("thread/start", {
      cwd: target.workspace || process.cwd(),
      threadSource: "user",
    });
    const threadId = result.thread?.id || result.thread?.sessionId;

    if (!threadId) {
      throw new Error("Codex did not return a thread id.");
    }

    const activeTarget = await agentStore.setActiveTarget(targetForThread(command, threadId, target));
    command.target = activeTarget;
    await appendBridgeEvent(command, {
      level: "system",
      text: `Created Codex chat ${activeTarget.label}.`,
      speak: false,
    });
    return threadId;
  }

  await client.request(
    "thread/resume",
    compact({
      threadId: route.threadId,
      cwd: target.workspace,
    }),
  );
  return route.threadId;
}

async function dispatchNow(command, route) {
  const client = new CodexAppServerClient(command);

  try {
    await appendBridgeEvent(command, {
      level: "system",
      text: "Sending command to Codex.",
      speak: false,
    });
    await client.start();
    const threadId = await resolveThread(client, command, route);
    const result = await client.request(
      "turn/start",
      {
        threadId,
        cwd: command.target?.workspace || null,
        input: [textInput(command.text)],
      },
      { timeoutMs: TURN_TIMEOUT_MS },
    );
    const turnId = result.turn?.id;

    if (turnId) {
      await client.waitForTurn(turnId);
    }

    await appendBridgeEvent(command, {
      level: "system",
      text: "Codex finished the command.",
      speak: false,
    });
  } catch (error) {
    await appendBridgeEvent(command, {
      level: "error",
      text: error.message || "Codex direct send failed.",
    }).catch(() => {});
  } finally {
    client.close();
  }
}

function dispatch(command) {
  const route = dispatchRoute(command);

  if (!route.accepted) {
    if (route.reason === "missing-thread-id") {
      appendBridgeEvent(command, {
        level: "warning",
        text: "This Codex target does not have a chat id yet. Say list chats, then use listed one, and send again.",
      }).catch(() => {});
    }

    return route;
  }

  dispatchChain = dispatchChain
    .catch(() => {})
    .then(() => dispatchNow(command, route));

  return route;
}

function status() {
  return {
    enabled: DIRECT_SEND_ENABLED,
    mode: "app-server-stdio",
    note: DIRECT_SEND_ENABLED
      ? "Codex targets with a thread id are sent through Codex app-server."
      : "Set CODEX_DIRECT_SEND=1 to enable direct Codex sends.",
  };
}

module.exports = {
  dispatch,
  dispatchRoute,
  extractThreadId,
  status,
};
