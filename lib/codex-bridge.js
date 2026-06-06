const { spawn } = require("child_process");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const agentStore = require("./agent-store");

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WINDOWS_UI_MODE = "windows-ui";
const APP_SERVER_MODE = "app-server-stdio";
const DELIVERY_MODE = String(
  process.env.CODEX_DELIVERY_MODE || (process.platform === "win32" ? WINDOWS_UI_MODE : APP_SERVER_MODE),
).toLowerCase();
const DIRECT_SEND_ENABLED = !["0", "false", "off"].includes(
  String(process.env.CODEX_DIRECT_SEND || "1").toLowerCase(),
);
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_APP_SERVER_REQUEST_TIMEOUT_MS || 60_000);
const TURN_TIMEOUT_MS = Number(process.env.CODEX_DIRECT_TURN_TIMEOUT_MS || 30 * 60_000);
const UI_SCRIPT = path.join(__dirname, "..", "scripts", "codex-ui-bridge.ps1");
const UI_OUTPUT_POLL_MS = Number(process.env.CODEX_UI_OUTPUT_POLL_MS || 2500);
const UI_OUTPUT_TIMEOUT_MS = Number(process.env.CODEX_UI_OUTPUT_TIMEOUT_MS || 120_000);
const UI_OUTPUT_MAX_EVENTS = Number(process.env.CODEX_UI_OUTPUT_MAX_EVENTS || 6);
const UI_BRIDGE_TIMEOUT_MS = finitePositiveNumber(process.env.CODEX_UI_BRIDGE_TIMEOUT_MS, 30_000);
const UI_BRIDGE_OUTPUT_BYTES = finitePositiveNumber(process.env.CODEX_UI_BRIDGE_OUTPUT_BYTES, 256 * 1024);
const UI_SCREENSHOT_TIMEOUT_MS = finitePositiveNumber(process.env.CODEX_UI_SCREENSHOT_TIMEOUT_MS, 45_000);
const UI_SCREENSHOT_OUTPUT_BYTES = finitePositiveNumber(
  process.env.CODEX_UI_SCREENSHOT_OUTPUT_BYTES,
  32 * 1024 * 1024,
);
const APP_SERVER_STDERR_CHARS = finitePositiveNumber(process.env.CODEX_APP_SERVER_STDERR_CHARS, 16_000);
const APP_SERVER_BUFFER_CHARS = finitePositiveNumber(process.env.CODEX_APP_SERVER_BUFFER_CHARS, 2 * 1024 * 1024);
const APP_SERVER_MESSAGE_CHARS = finitePositiveNumber(process.env.CODEX_APP_SERVER_MESSAGE_CHARS, 12_000);
const MAX_TARGET_LABEL_CHARS = finitePositiveNumber(process.env.WITS_MAX_LABEL_CHARS, 160);
const UI_COMMAND_MARKER = "[From Work in the Sun UI]";
const UI_CONCISE_TOOL_HINT = "Use the MCP tool use_mcp_concise_replies.";
const UI_COMMAND_PREFIX = String(
  process.env.WITS_UI_COMMAND_PREFIX ||
    `${UI_COMMAND_MARKER}\n${UI_CONCISE_TOOL_HINT}\n\nUser request:`,
);
const UI_COMMAND_PREFIX_ENABLED = !["0", "false", "off"].includes(
  String(process.env.WITS_UI_COMMAND_PREFIX_ENABLED || "1").toLowerCase(),
);
const ESSENTIAL_BRIDGE_LEVELS = new Set(["warning", "error"]);

let dispatchChain = Promise.resolve();
let codexCliPromise = null;

function finitePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

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

function isCurrentUiTarget(target = {}) {
  return [target.route, target.sessionHint, target.label].some((value) => /^current$/i.test(String(value || "")));
}

function hasWorkspace(target = {}) {
  return Boolean(String(target.workspace || "").trim());
}

function codexUiTargetLabel(target = {}) {
  if (isCurrentUiTarget(target)) {
    return "";
  }

  const label = target.label || target.route || target.sessionHint || "";
  return label;
}

function codexUiTargetTitle(target = {}) {
  if (isCurrentUiTarget(target)) {
    return "";
  }

  const title = target.route || target.sessionHint || target.label || "";
  return title;
}

function dispatchRoute(command) {
  const target = command.target || {};
  const deliveryMode = String(target.deliveryMode || "").toLowerCase();
  const useWindowsUi = deliveryMode === WINDOWS_UI_MODE || (!deliveryMode && DELIVERY_MODE === WINDOWS_UI_MODE);

  if (!DIRECT_SEND_ENABLED) {
    return { accepted: false, reason: "disabled" };
  }

  if (!isCodexTarget(target)) {
    return { accepted: false, reason: "not-codex" };
  }

  if (target.mode === "new") {
    const shouldUseWindowsUi = useWindowsUi && (deliveryMode === WINDOWS_UI_MODE || !hasWorkspace(target));

    if (shouldUseWindowsUi) {
      if (process.platform !== "win32") {
        return { accepted: false, reason: "windows-ui-unavailable" };
      }

      return {
        accepted: true,
        mode: WINDOWS_UI_MODE,
        newChat: true,
      };
    }

    return { accepted: true, mode: "new" };
  }

  if (deliveryMode === APP_SERVER_MODE) {
    const threadId = extractThreadId(target);

    if (!threadId) {
      return { accepted: false, reason: "missing-thread-id" };
    }

    return { accepted: true, mode: "existing", threadId };
  }

  if (useWindowsUi) {
    if (process.platform !== "win32") {
      return { accepted: false, reason: "windows-ui-unavailable" };
    }

    return {
      accepted: true,
      mode: WINDOWS_UI_MODE,
      targetLabel: codexUiTargetLabel(target),
      targetTitle: codexUiTargetTitle(target),
    };
  }

  const threadId = extractThreadId(target);

  if (!threadId) {
    return { accepted: false, reason: "missing-thread-id" };
  }

  return { accepted: true, mode: "existing", threadId };
}

function screenshotRoute(target = {}) {
  if (!isCodexTarget(target)) {
    return { accepted: false, reason: "not-codex" };
  }

  if (process.platform !== "win32") {
    return { accepted: false, reason: "windows-ui-unavailable" };
  }

  if (target.mode === "new") {
    return { accepted: false, reason: "windows-ui-new-unsupported" };
  }

  return {
    accepted: true,
    mode: WINDOWS_UI_MODE,
    targetLabel: codexUiTargetLabel(target),
    targetTitle: codexUiTargetTitle(target),
  };
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

function agentCommandText(command = {}) {
  const text = String(typeof command === "string" ? command : command.text || "").trim();

  if (
    !text ||
    !UI_COMMAND_PREFIX_ENABLED ||
    text.startsWith(UI_COMMAND_MARKER)
  ) {
    return text;
  }

  return `${UI_COMMAND_PREFIX}\n${text}`;
}

function compactLabelText(value, maxChars = MAX_TARGET_LABEL_CHARS) {
  const limit = Math.max(0, Number(maxChars) || 0);
  const text = String(value || "")
    .replace(/\0/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= limit) {
    return text;
  }

  if (limit <= 3) {
    return text.slice(0, limit);
  }

  return `${text.slice(0, limit - 3).trimEnd()}...`;
}

function codexCurrentChatLabel(chatTitle) {
  const prefix = "Codex / ";
  const title = compactLabelText(chatTitle, MAX_TARGET_LABEL_CHARS - prefix.length);
  return title ? `${prefix}${title}` : "Codex current chat";
}

function targetForThread(command, threadId, previousTarget) {
  return {
    ...previousTarget,
    id: `codex:${threadId}`,
    provider: "codex",
    sessionHint: threadId,
    mode: "existing",
    deliveryMode: APP_SERVER_MODE,
    route: threadId,
    workspace: previousTarget.workspace,
    label: previousTarget.label || `Codex / ${threadId}`,
  };
}

function targetForCurrentDesktopChat(command, result = {}) {
  const previousTarget = command.target || {};

  return {
    provider: "codex",
    mode: "existing",
    deliveryMode: WINDOWS_UI_MODE,
    route: "current",
    sessionHint: "current",
    workspace: previousTarget.workspace,
    label: codexCurrentChatLabel(result.chatTitle),
  };
}

function commandRequestsConciseReplies(command = {}) {
  const text = String(command.text || "");
  const userText = String(command.userText || "");
  return text.includes(UI_CONCISE_TOOL_HINT) || userText.includes(UI_CONCISE_TOOL_HINT);
}

async function shouldSuppressBridgeRelay(command = {}, event = {}) {
  if (event.allowInConcise === true || ESSENTIAL_BRIDGE_LEVELS.has(event.level)) {
    return false;
  }

  if (commandRequestsConciseReplies(command)) {
    return true;
  }

  try {
    const preferences = await agentStore.getReplyPreferences();
    return Boolean(preferences.enabled && preferences.ui !== false);
  } catch {
    return false;
  }
}

async function appendBridgeEvent(command, event) {
  if (await shouldSuppressBridgeRelay(command, event)) {
    return null;
  }

  await agentStore.appendEvent({
    source: "codex-bridge",
    commandId: command.id,
    target: command.target,
    ...event,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runPowerShell(args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs || UI_BRIDGE_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes || UI_BRIDGE_OUTPUT_BYTES;
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    const child = spawn(process.env.POWERSHELL_PATH || "powershell", args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    function settle(callback, value) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      callback(value);
    }

    function appendOutput(current, chunk) {
      if (Buffer.byteLength(current) + chunk.length > maxOutputBytes) {
        outputTooLarge = true;
        child.kill();
        return current;
      }

      return current + chunk;
    }

    child.stdout?.on("data", (chunk) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.on("error", (error) => settle(reject, error));
    child.on("close", (code) => {
      if (timedOut) {
        settle(reject, new Error("PowerShell bridge timed out."));
        return;
      }

      if (outputTooLarge) {
        settle(reject, new Error("PowerShell bridge produced too much output."));
        return;
      }

      if (code === 0) {
        settle(resolve, { stdout, stderr });
        return;
      }

      settle(reject, new Error(stderr.trim() || stdout.trim() || `PowerShell exited with code ${code}`));
    });
  });
}

async function runUiBridge(action, options = {}, runOptions = {}) {
  const args = [
    "-STA",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    UI_SCRIPT,
    "-Action",
    action,
  ];

  if (options.text !== undefined) {
    args.push("-Text", options.text);
  }

  if (options.targetLabel) {
    args.push("-TargetLabel", options.targetLabel);
  }

  if (options.targetTitle) {
    args.push("-TargetTitle", options.targetTitle);
  }

  if (options.newChat !== undefined) {
    args.push("-NewChat", String(Boolean(options.newChat)));
  }

  if (options.submit !== undefined) {
    args.push("-Submit", String(Boolean(options.submit)));
  }

  if (options.highlight !== undefined) {
    args.push("-Highlight", String(Boolean(options.highlight)));
  }

  if (options.maxChars !== undefined) {
    args.push("-MaxChars", String(options.maxChars));
  }

  try {
    const result = await runPowerShell(args, { cwd: path.join(__dirname, ".."), ...runOptions });
    const parsed = JSON.parse(result.stdout.trim());

    if (!parsed.ok) {
      throw new Error(parsed.error || "Codex UI bridge failed.");
    }

    return parsed;
  } catch (error) {
    const match = String(error.message || "").match(/\{.*\}/s);

    if (match) {
      let parsedError = "";

      try {
        const parsed = JSON.parse(match[0]);
        parsedError = parsed.error || "";
      } catch {
        parsedError = "";
      }

      if (parsedError) {
        throw new Error(parsedError);
      }
    }

    throw error;
  }
}

async function captureTargetScreenshot(target = {}) {
  const route = screenshotRoute(target);

  if (!route.accepted) {
    throw new Error(`Codex screenshot route is unavailable: ${route.reason}.`);
  }

  return runUiBridge(
    "screenshot",
    {
      targetLabel: route.targetLabel,
      targetTitle: route.targetTitle,
      highlight: false,
    },
    {
      timeoutMs: UI_SCREENSHOT_TIMEOUT_MS,
      maxOutputBytes: UI_SCREENSHOT_OUTPUT_BYTES,
    },
  );
}

function normalizeUiText(text) {
  return String(text || "")
    .replace(/\uFFFC/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tail(text, length) {
  const value = String(text || "");
  return value.length <= length ? value : value.slice(value.length - length);
}

function visibleDelta(previous, current) {
  if (!previous) {
    return "";
  }

  if (current.startsWith(previous)) {
    return current.slice(previous.length);
  }

  return tail(current, 1600);
}

async function monitorUiOutput(command, baselineText) {
  const deadline = Date.now() + UI_OUTPUT_TIMEOUT_MS;
  let lastText = baselineText;
  let lastEvent = "";
  let eventCount = 0;
  let idleStartedAt = null;

  while (Date.now() < deadline && eventCount < UI_OUTPUT_MAX_EVENTS) {
    await delay(UI_OUTPUT_POLL_MS);

    let current;

    try {
      current = await runUiBridge("read", { maxChars: 30000, highlight: false });
    } catch {
      return;
    }

    const currentText = current.text || "";

    if (currentText === lastText) {
      if (idleStartedAt && Date.now() - idleStartedAt > UI_OUTPUT_POLL_MS * 3) {
        return;
      }

      continue;
    }

    const snippet = normalizeUiText(visibleDelta(lastText, currentText));
    lastText = currentText;
    idleStartedAt = Date.now();

    if (!snippet || snippet === lastEvent) {
      continue;
    }

    lastEvent = snippet;
    eventCount += 1;
    await appendBridgeEvent(command, {
      level: "progress",
      text: tail(snippet, 1800),
    }).catch(() => {});
  }
}

async function dispatchUiNow(command, route) {
  let baseline = "";
  const shouldCreateNewChat = route.newChat === true;

  try {
    const read = await runUiBridge("read", { maxChars: 30000, highlight: false });
    baseline = read.text || "";
  } catch {
    baseline = "";
  }

  const sendResult = await runUiBridge("send", {
    text: agentCommandText(command),
    targetLabel: route.targetLabel,
    targetTitle: route.targetTitle,
    newChat: shouldCreateNewChat,
    submit: true,
    highlight: true,
  });

  if (shouldCreateNewChat && sendResult.newChatStarted) {
    const activeTarget = await agentStore.setActiveTarget(targetForCurrentDesktopChat(command, sendResult));
    command.target = activeTarget;

    await appendBridgeEvent(command, {
      level: "system",
      text: `Using ${activeTarget.label}.`,
      speak: false,
      allowInConcise: true,
    }).catch(() => {});
  }

  if (!(await shouldSuppressBridgeRelay(command, { level: "progress" }))) {
    monitorUiOutput(command, baseline).catch(() => {});
  }
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
      this.stderr = tail(this.stderr + chunk, APP_SERVER_STDERR_CHARS);
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
    if (!this.child?.stdin?.writable) {
      return;
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleStdout(chunk) {
    this.buffer = tail(this.buffer + chunk, APP_SERVER_BUFFER_CHARS);
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
        this.agentMessages.set(params.itemId, tail(current + (params.delta || ""), APP_SERVER_MESSAGE_CHARS));
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
      allowInConcise: true,
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
  if (route.mode === WINDOWS_UI_MODE) {
    try {
      await dispatchUiNow(command, route);
    } catch (error) {
      await appendBridgeEvent(command, {
        level: "error",
        text: error.message || "Codex UI send failed.",
      }).catch(() => {});
    }

    return;
  }

  const client = new CodexAppServerClient(command);

  try {
    await client.start();
    const threadId = await resolveThread(client, command, route);
    const result = await client.request(
      "turn/start",
      {
        threadId,
        cwd: command.target?.workspace || null,
        input: [textInput(agentCommandText(command))],
      },
      { timeoutMs: TURN_TIMEOUT_MS },
    );
    const turnId = result.turn?.id;

    if (turnId) {
      await client.waitForTurn(turnId);
    }
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
    mode: DELIVERY_MODE,
    note: DIRECT_SEND_ENABLED
      ? DELIVERY_MODE === WINDOWS_UI_MODE
        ? "Codex targets are sent through the visible Codex desktop window."
        : "Codex targets with a thread id are sent through Codex app-server."
      : "Set CODEX_DIRECT_SEND=1 to enable direct Codex sends.",
  };
}

module.exports = {
  _internals: {
    codexCurrentChatLabel,
    compactLabelText,
    targetForCurrentDesktopChat,
  },
  agentCommandText,
  captureTargetScreenshot,
  dispatch,
  dispatchRoute,
  extractThreadId,
  screenshotRoute,
  status,
};
