const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const agentStore = require("./lib/agent-store");
const codexBridge = require("./lib/codex-bridge");
const codexCatalog = require("./lib/codex-catalog");
const windowScreenshot = require("./lib/window-screenshot");
const packageJson = require("./package.json");

const DEFAULT_PORT = 38173;
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.WITS_HTTP_PORT || process.env.PORT || DEFAULT_PORT);
const APP_DIR = path.join(__dirname, "app");
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SCREENSHOT_BYTES = finitePositiveNumber(process.env.WITS_MAX_SCREENSHOT_BYTES, 16 * 1024 * 1024);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SILENCE_RMS_THRESHOLD = Number(process.env.SILENCE_RMS_THRESHOLD || 0.003);
const SILENCE_PEAK_THRESHOLD = Number(process.env.SILENCE_PEAK_THRESHOLD || 0.02);
const PIN_PATH = process.env.WITS_PIN_PATH || path.join(__dirname, ".local", "access-pin");
const PIN_FAILURE_LOG_PATH =
  process.env.WITS_PIN_FAILURE_LOG_PATH || path.join(__dirname, ".local", "pin-failures.log");
const PIN_LOCKOUT_PATH = process.env.WITS_PIN_LOCKOUT_PATH || path.join(__dirname, ".local", "pin-lockout.json");
const PIN_KEY_PATH = process.env.WITS_PIN_KEY_PATH || path.join(__dirname, ".local", "pin-unlock-key.json");
const ACCESS_PIN = readSecret(process.env.WITS_ACCESS_PIN, PIN_PATH);
const PIN_ENABLED = Boolean(ACCESS_PIN);
const CONFIGURED_ACCESS_TOKEN = String(process.env.WITS_ACCESS_TOKEN || process.env.WORK_IN_THE_SUN_TOKEN || "").trim();
const ACCESS_TOKEN = CONFIGURED_ACCESS_TOKEN || (PIN_ENABLED ? crypto.randomBytes(32).toString("hex") : "");
const MIN_ACCESS_TOKEN_CHARS = 24;
const MIN_PIN_CHARS = finitePositiveNumber(process.env.WITS_MIN_PIN_CHARS, 6);
const MAX_PIN_CHARS = finitePositiveNumber(process.env.WITS_MAX_PIN_CHARS, 128);
const PIN_FAILURE_LIMIT = finitePositiveNumber(process.env.WITS_PIN_FAILURE_LIMIT, 3);
const ALLOW_WEAK_ACCESS_TOKEN = booleanEnv("WITS_ALLOW_WEAK_TOKEN");
const ALLOW_WEAK_PIN = booleanEnv("WITS_ALLOW_WEAK_PIN");
const IGNORE_PIN_LOCKOUT = booleanEnv("WITS_IGNORE_PIN_LOCKOUT");
const ALLOW_UNAUTHENTICATED_REMOTE = booleanEnv("WITS_ALLOW_UNAUTHENTICATED_REMOTE");
const ALLOWED_HOSTS = new Set(parseCsv(process.env.WITS_ALLOWED_HOSTS));
const ALLOWED_ORIGINS = new Set(parseCsv(process.env.WITS_ALLOWED_ORIGINS));
const API_RATE_LIMIT = finitePositiveNumber(process.env.WITS_API_RATE_LIMIT, 240);
const COMMAND_RATE_LIMIT = finitePositiveNumber(process.env.WITS_COMMAND_RATE_LIMIT, 60);
const SPEECH_RATE_LIMIT = finitePositiveNumber(process.env.WITS_SPEECH_RATE_LIMIT, 30);
const SCREENSHOT_RATE_LIMIT = finitePositiveNumber(process.env.WITS_SCREENSHOT_RATE_LIMIT, 20);
const RATE_LIMIT_WINDOW_MS = finitePositiveNumber(process.env.WITS_RATE_LIMIT_WINDOW_MS, 60_000);
const CHILD_PROCESS_TIMEOUT_MS = finitePositiveNumber(process.env.WITS_CHILD_PROCESS_TIMEOUT_MS, 120_000);
const CHILD_PROCESS_OUTPUT_BYTES = finitePositiveNumber(process.env.WITS_CHILD_PROCESS_OUTPUT_BYTES, 512 * 1024);
const PIN_UNLOCK_AAD = "work-in-the-sun:pin-unlock:v1";
const PIN_KEY_PAIR = PIN_ENABLED ? loadOrCreatePinKeyPair() : null;
const APP_VERSION = String(packageJson.version || "0.0.0");

const LOCAL_DICTATE_CANDIDATES = [
  process.env.LOCAL_DICTATE_ROOT,
  path.join(__dirname, "vendor", "local-dictate"),
  path.resolve(__dirname, "..", "local-dictate"),
].filter(Boolean);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
]);

const rateBuckets = new Map();
let failedPinAttempts = 0;
let shutdownScheduled = false;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function booleanEnv(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

function finitePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function readSecret(value, filePath) {
  const configured = String(value || "").trim();

  if (configured) {
    return configured;
  }

  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function readJsonFileSync(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pinKeyFingerprint(publicKeyPem) {
  const publicDer = crypto.createPublicKey(publicKeyPem).export({
    type: "spki",
    format: "der",
  });
  return base64Url(crypto.createHash("sha256").update(publicDer).digest());
}

function loadOrCreatePinKeyPair() {
  const existing = readJsonFileSync(PIN_KEY_PATH);

  if (existing?.publicKeyPem && existing?.privateKeyPem) {
    return {
      publicKeyPem: existing.publicKeyPem,
      privateKeyPem: existing.privateKeyPem,
      publicKeyDer: crypto
        .createPublicKey(existing.publicKeyPem)
        .export({ type: "spki", format: "der" })
        .toString("base64"),
      fingerprint: pinKeyFingerprint(existing.publicKeyPem),
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });
  const record = {
    createdAt: new Date().toISOString(),
    algorithm: "RSA-OAEP-256",
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    fingerprint: pinKeyFingerprint(publicKey),
  };

  fs.mkdirSync(path.dirname(PIN_KEY_PATH), { recursive: true });
  fs.writeFileSync(PIN_KEY_PATH, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    publicKeyDer: crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" }).toString("base64"),
    fingerprint: record.fingerprint,
  };
}

function securityHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(self), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

function json(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, securityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
  }));
  response.end(payload);
}

function text(response, status, body, headers = {}) {
  const payload = Buffer.from(body);
  response.writeHead(status, securityHeaders({
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": payload.length,
    ...headers,
  }));
  response.end(payload);
}

function normalizeHostName(value) {
  const host = String(value || "").trim().toLowerCase();

  if (!host) {
    return "";
  }

  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 0 ? host.slice(1, end) : host;
  }

  const portIndex = host.lastIndexOf(":");

  if (portIndex > -1 && host.indexOf(":") === portIndex && /^\d+$/.test(host.slice(portIndex + 1))) {
    return host.slice(0, portIndex);
  }

  return host;
}

function normalizeHostHeader(value) {
  return String(value || "").trim().toLowerCase();
}

function isLoopbackHost(value) {
  const host = normalizeHostName(value);
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function isWildcardHost(value) {
  const host = normalizeHostName(value);
  return host === "0.0.0.0" || host === "::" || host === "*" || host === "+";
}

function isAllowedHost(value) {
  const host = normalizeHostName(value);
  return isLoopbackHost(host) || ALLOWED_HOSTS.has(host);
}

function validateStartupSecurity() {
  if (CONFIGURED_ACCESS_TOKEN && CONFIGURED_ACCESS_TOKEN.length < MIN_ACCESS_TOKEN_CHARS && !ALLOW_WEAK_ACCESS_TOKEN) {
    throw new Error(
      `WITS_ACCESS_TOKEN must be at least ${MIN_ACCESS_TOKEN_CHARS} characters. Set WITS_ALLOW_WEAK_TOKEN=1 only for local testing.`,
    );
  }

  if (PIN_ENABLED && ACCESS_PIN.length < MIN_PIN_CHARS && !ALLOW_WEAK_PIN) {
    throw new Error(
      `The access PIN must be at least ${MIN_PIN_CHARS} characters. Set WITS_ALLOW_WEAK_PIN=1 only for local testing.`,
    );
  }

  if (PIN_ENABLED && ACCESS_PIN.length > MAX_PIN_CHARS) {
    throw new Error(`The access PIN must be ${MAX_PIN_CHARS} characters or fewer.`);
  }

  const lockout = readJsonFileSync(PIN_LOCKOUT_PATH);

  if (lockout && !IGNORE_PIN_LOCKOUT) {
    throw new Error(
      `Backend startup blocked by failed PIN lockout at ${PIN_LOCKOUT_PATH}. Clear it intentionally before restarting.`,
    );
  }

  if (ACCESS_TOKEN || ALLOW_UNAUTHENTICATED_REMOTE) {
    return;
  }

  if (isWildcardHost(HOST) || !isLoopbackHost(HOST)) {
    throw new Error("Remote HTTP binding requires WITS_ACCESS_TOKEN.");
  }
}

function timingSafeTokenEquals(candidate) {
  const actual = Buffer.from(String(candidate || ""));
  const expected = Buffer.from(ACCESS_TOKEN);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function requestToken(request) {
  const explicitHeader = request.headers["x-wits-token"] || request.headers["x-work-in-the-sun-token"];
  const authorization = request.headers.authorization || "";
  const bearer = String(authorization).match(/^Bearer\s+(.+)$/i)?.[1];
  return Array.isArray(explicitHeader) ? explicitHeader[0] : explicitHeader || bearer || "";
}

function verifyAccessToken(request) {
  return ACCESS_TOKEN && timingSafeTokenEquals(requestToken(request));
}

function verifyAccessPin(pin) {
  const actual = Buffer.from(String(pin || "").trim());
  const expected = Buffer.from(ACCESS_PIN);
  return PIN_ENABLED && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function assertTrustedOrigin(request) {
  const origin = request.headers.origin;

  if (!origin) {
    return;
  }

  let parsed;

  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, "Untrusted request origin.");
  }

  const allowedOrigin = ALLOWED_ORIGINS.has(parsed.origin.toLowerCase());
  const sameHost = parsed.host.toLowerCase() === normalizeHostHeader(request.headers.host);

  if (!allowedOrigin && !sameHost) {
    throw new HttpError(403, "Untrusted request origin.");
  }
}

function clientAddress(request) {
  return request.socket.remoteAddress || "unknown";
}

function checkRateLimit(request, scope, limit, windowMs = RATE_LIMIT_WINDOW_MS) {
  const now = Date.now();
  const key = `${scope}:${clientAddress(request)}`;
  const bucket = rateBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, {
      count: 1,
      resetAt: now + windowMs,
    });
    return;
  }

  bucket.count += 1;

  if (bucket.count > limit) {
    throw new HttpError(429, "Too many requests.");
  }
}

function authorizeApiRequest(request) {
  assertTrustedOrigin(request);
  checkRateLimit(request, "api", API_RATE_LIMIT);

  if (ACCESS_TOKEN) {
    if (!verifyAccessToken(request)) {
      throw new HttpError(401, "Missing or invalid access token.");
    }

    return;
  }

  if (!isAllowedHost(request.headers.host) && !ALLOW_UNAUTHENTICATED_REMOTE) {
    throw new HttpError(403, "Remote HTTP access requires WITS_ACCESS_TOKEN.");
  }
}

function authorizeSessionRequest(request) {
  assertTrustedOrigin(request);
  checkRateLimit(request, "session", COMMAND_RATE_LIMIT);
}

function assertJsonRequest(request) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();

  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "Expected application/json.");
  }
}

function assertAudioRequest(request) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  const allowed = [
    "audio/webm",
    "audio/ogg",
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/x-wav",
    "application/octet-stream",
  ];

  if (!allowed.some((item) => contentType.startsWith(item))) {
    throw new HttpError(415, "Expected an audio request body.");
  }
}

function resolveLocalDictate() {
  const attempted = [];

  for (const root of LOCAL_DICTATE_CANDIDATES) {
    const candidate = localDictatePaths(root);
    attempted.push(candidate);

    if (candidate.available) {
      return { ...candidate, attempted };
    }
  }

  return {
    available: false,
    attempted,
    missing: attempted.at(-1)?.missing || ["local-dictate release"],
  };
}

function localDictatePaths(root) {
  const isWindows = process.platform === "win32";
  const cliNames = isWindows
    ? [
        "local-dictate-cli.exe",
        path.join("bin", "local-dictate-cli.exe"),
        path.join("target", "release", "local-dictate-cli.exe"),
        path.join("target", "debug", "local-dictate-cli.exe"),
      ]
    : [
        path.join("bin", "local-dictate-cli"),
        "local-dictate-cli",
        path.join("target", "release", "local-dictate-cli"),
        path.join("target", "debug", "local-dictate-cli"),
      ];

  const engineName = isWindows ? "whisper-cli.exe" : "whisper-cli";
  const paths = {
    root,
    cli: firstExisting(root, cliNames),
    engine: path.join(root, "engines", engineName),
    model: path.join(root, "models", "ggml-base.en.bin"),
  };

  const missing = Object.entries(paths)
    .filter(([key, value]) => key !== "root" && !isFile(value))
    .map(([key]) => key);

  return {
    ...paths,
    available: missing.length === 0,
    missing,
  };
}

function firstExisting(root, relativePaths) {
  for (const relativePath of relativePaths) {
    const candidate = path.join(root, relativePath);

    if (isFile(candidate)) {
      return candidate;
    }
  }

  return path.join(root, relativePaths[0]);
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function audioExtension(contentType = "") {
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("mpeg")) return "mp3";
  if (contentType.includes("mp4")) return "m4a";
  if (contentType.includes("wav")) return "wav";
  return "bin";
}

function normalizeTranscript(text) {
  const transcript = text.trim();

  if (isBlankAudioTranscript(transcript)) {
    return "";
  }

  return transcript;
}

function isBlankAudioTranscript(text) {
  return /^\[?\(?blank[_\s-]*audio\)?\]?\.?$/i.test(text.trim());
}

async function isEffectivelySilentWav(wavPath) {
  const wav = await fsp.readFile(wavPath);
  const dataOffset = findWavDataOffset(wav);

  if (dataOffset < 0) {
    return false;
  }

  const sampleCount = Math.floor((wav.length - dataOffset) / 2);

  if (!sampleCount) {
    return true;
  }

  let sumSquares = 0;
  let peak = 0;

  for (let offset = dataOffset; offset + 1 < wav.length; offset += 2) {
    const sample = Math.abs(wav.readInt16LE(offset)) / 32768;
    sumSquares += sample * sample;
    peak = Math.max(peak, sample);
  }

  const rms = Math.sqrt(sumSquares / sampleCount);
  return rms <= SILENCE_RMS_THRESHOLD && peak <= SILENCE_PEAK_THRESHOLD;
}

function findWavDataOffset(wav) {
  let offset = 12;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString("ascii", offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;

    if (chunkId === "data") {
      return dataOffset;
    }

    offset = dataOffset + chunkSize + (chunkSize % 2);
  }

  return -1;
}

function readBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      if (tooLarge) {
        return;
      }

      size += chunk.length;

      if (size > maxBytes) {
        tooLarge = true;
        reject(new HttpError(413, "Request body is too large."));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJson(request, maxBytes) {
  assertJsonRequest(request);
  const body = await readBody(request, maxBytes);

  if (!body.length) {
    return {};
  }

  try {
    const parsed = JSON.parse(body.toString("utf8"));

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON body must be an object.");
    }

    return parsed;
  } catch (error) {
    throw new HttpError(400, error.message || "Invalid JSON body.");
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs || CHILD_PROCESS_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes || CHILD_PROCESS_OUTPUT_BYTES;
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    const child = spawn(command, args, {
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
        settle(reject, new Error(`${command} timed out.`));
        return;
      }

      if (outputTooLarge) {
        settle(reject, new Error(`${command} produced too much output.`));
        return;
      }

      if (code === 0) {
        settle(resolve, { stdout, stderr });
        return;
      }

      settle(reject, new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function speechHealth() {
  const localDictate = resolveLocalDictate();
  let ffmpegAvailable = false;

  try {
    await run(FFMPEG, ["-version"], { timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }

  const missing = [
    ...(localDictate.available ? [] : localDictate.missing),
    ...(ffmpegAvailable ? [] : ["ffmpeg"]),
  ];

  return {
    available: localDictate.available && ffmpegAvailable,
    localDictate,
    ffmpeg: {
      available: ffmpegAvailable,
      command: FFMPEG,
    },
    missing,
  };
}

async function transcribe(request, response) {
  checkRateLimit(request, "speech", SPEECH_RATE_LIMIT);
  assertAudioRequest(request);
  const speech = await speechHealth();

  if (!speech.available) {
    json(response, 503, {
      error: "Speech backend is not ready.",
      missing: speech.missing,
    });
    return;
  }

  const { localDictate } = speech;

  const input = await readBody(request, MAX_AUDIO_BYTES);

  if (!input.length) {
    json(response, 400, { error: "Missing audio body." });
    return;
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "work-in-the-sun-"));
  const extension = audioExtension(request.headers["content-type"] || "");
  const id = crypto.randomUUID();
  const inputPath = path.join(tempRoot, `${id}.input.${extension}`);
  const wavPath = path.join(tempRoot, `${id}.wav`);

  try {
    await fsp.writeFile(inputPath, input);
    await run(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ],
      { timeoutMs: 60_000 },
    );

    if (await isEffectivelySilentWav(wavPath)) {
      json(response, 200, {
        text: "",
        blank: true,
        engine: "silence-gate",
      });
      return;
    }

    const result = await run(
      localDictate.cli,
      [
        "--engine",
        localDictate.engine,
        "--model",
        localDictate.model,
        "--audio",
        wavPath,
        "--language",
        process.env.LOCAL_DICTATE_LANGUAGE || "en",
      ],
      { cwd: localDictate.root, timeoutMs: 120_000 },
    );

    const text = normalizeTranscript(result.stdout);

    json(response, 200, {
      text,
      blank: !text,
      engine: "local-dictate",
    });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

async function synthesize(request, response) {
  checkRateLimit(request, "speech", SPEECH_RATE_LIMIT);

  if (process.platform !== "win32") {
    json(response, 501, { error: "Desktop TTS is only implemented for Windows right now." });
    return;
  }

  const body = await readJson(request, MAX_JSON_BYTES);
  const text = String(body.text || "").trim();

  if (!text) {
    json(response, 400, { error: "Missing text." });
    return;
  }

  if (text.length > 2000) {
    json(response, 400, { error: "Text is too long for echo." });
    return;
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "work-in-the-sun-tts-"));
  const wavPath = path.join(tempRoot, `${crypto.randomUUID()}.wav`);
  const scriptPath = path.join(__dirname, "scripts", "synthesize-speech.ps1");

  try {
    await run(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Text",
        text,
        "-OutputPath",
        wavPath,
      ],
      { timeoutMs: 30_000 },
    );

    const wav = await fsp.readFile(wavPath);
    response.writeHead(200, securityHeaders({
      "Content-Type": "audio/wav",
      "Content-Length": wav.length,
      "Cache-Control": "no-store",
    }));
    response.end(wav);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

async function getAgentTarget(response) {
  const target = await agentStore.getActiveTarget();
  json(response, 200, { target });
}

async function sessionStatus(request, response) {
  authorizeSessionRequest(request);
  json(response, 200, {
    identity: sessionIdentity(request),
    pinRequired: PIN_ENABLED,
    authenticated: !ACCESS_TOKEN || verifyAccessToken(request),
    pinUnlock: PIN_ENABLED
      ? {
          encrypted: true,
          algorithm: "RSA-OAEP-256+A256GCM",
          publicKey: PIN_KEY_PAIR.publicKeyDer,
          fingerprint: PIN_KEY_PAIR.fingerprint,
          maxPinChars: MAX_PIN_CHARS,
        }
      : null,
  });
}

async function appendPinFailureLog(request, attemptsRemaining) {
  const record = {
    receivedAt: new Date().toISOString(),
    remoteAddress: clientAddress(request),
    host: String(request.headers.host || "").slice(0, 200),
    userAgent: String(request.headers["user-agent"] || "").slice(0, 300),
    failedAttempts: failedPinAttempts,
    attemptsRemaining,
  };
  const line = `${JSON.stringify(record)}\n`;

  console.warn(
    `Access PIN failure from ${record.remoteAddress}; ${attemptsRemaining} attempt${
      attemptsRemaining === 1 ? "" : "s"
    } remaining.`,
  );

  try {
    await fsp.mkdir(path.dirname(PIN_FAILURE_LOG_PATH), { recursive: true });
    await fsp.appendFile(PIN_FAILURE_LOG_PATH, line, "utf8");
  } catch (error) {
    console.error("Could not write PIN failure log.", error);
  }
}

async function writePinLockout(request) {
  const record = {
    lockedAt: new Date().toISOString(),
    reason: "failed-pin-attempts",
    failedAttempts: failedPinAttempts,
    remoteAddress: clientAddress(request),
    host: String(request.headers.host || "").slice(0, 200),
  };

  try {
    await fsp.mkdir(path.dirname(PIN_LOCKOUT_PATH), { recursive: true });
    await fsp.writeFile(PIN_LOCKOUT_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch (error) {
    console.error("Could not write PIN lockout marker.", error);
  }
}

async function scheduleShutdownAfterPinFailures(request) {
  if (shutdownScheduled) {
    return;
  }

  shutdownScheduled = true;
  await writePinLockout(request);
  console.error(`Access PIN failed ${failedPinAttempts} times. Shutting down backend.`);

  setTimeout(() => {
    server.close(() => process.exit(1));
    setTimeout(() => process.exit(1), 1000).unref();
  }, 100).unref();
}

function decryptPinUnlock(body) {
  if (body.pin !== undefined) {
    throw new HttpError(400, "Plaintext PIN unlock is disabled.");
  }

  if (body.keyFingerprint !== PIN_KEY_PAIR.fingerprint) {
    throw new HttpError(400, "PIN encryption key mismatch.");
  }

  const encryptedPin = String(body.encryptedPin || "");

  if (!/^[a-zA-Z0-9+/=]+$/.test(encryptedPin) || encryptedPin.length > 2048) {
    throw new HttpError(400, "Invalid encrypted PIN payload.");
  }

  let decrypted;

  try {
    decrypted = crypto.privateDecrypt(
      {
        key: PIN_KEY_PAIR.privateKeyPem,
        oaepHash: "sha256",
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(encryptedPin, "base64"),
    );
  } catch {
    throw new HttpError(400, "Invalid encrypted PIN payload.");
  }

  let payload;

  try {
    payload = JSON.parse(decrypted.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid encrypted PIN payload.");
  }

  const pin = String(payload.pin || "").trim();
  const responseKey = Buffer.from(String(payload.responseKey || ""), "base64");

  if (!pin || pin.length > MAX_PIN_CHARS || responseKey.length !== 32) {
    throw new HttpError(400, "Invalid encrypted PIN payload.");
  }

  return {
    pin,
    responseKey,
  };
}

function encryptedUnlockResponse(responseKey, body) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", responseKey, iv);
  cipher.setAAD(Buffer.from(PIN_UNLOCK_AAD));

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(body), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    encrypted: true,
    algorithm: "A256GCM",
    aad: PIN_UNLOCK_AAD,
    iv: iv.toString("base64"),
    ciphertext: Buffer.concat([encrypted, tag]).toString("base64"),
  };
}

async function failPinUnlock(request, response, message = "Invalid PIN.") {
  failedPinAttempts += 1;
  const attemptsRemaining = Math.max(0, PIN_FAILURE_LIMIT - failedPinAttempts);
  await appendPinFailureLog(request, attemptsRemaining);

  if (failedPinAttempts >= PIN_FAILURE_LIMIT) {
    json(response, 403, {
      error: "Too many failed PIN attempts. Backend is shutting down.",
      attemptsRemaining,
    });
    await scheduleShutdownAfterPinFailures(request);
    return;
  }

  json(response, 403, {
    error: message,
    attemptsRemaining,
  });
}

async function unlockSession(request, response) {
  authorizeSessionRequest(request);

  if (!PIN_ENABLED) {
    json(response, 404, { error: "Access PIN is not configured." });
    return;
  }

  const body = await readJson(request, MAX_JSON_BYTES);
  let unlock;

  try {
    unlock = decryptPinUnlock(body);
  } catch (error) {
    await failPinUnlock(request, response);
    return;
  }

  if (verifyAccessPin(unlock.pin)) {
    failedPinAttempts = 0;
    json(response, 200, encryptedUnlockResponse(unlock.responseKey, { accessToken: ACCESS_TOKEN }));
    return;
  }

  await failPinUnlock(request, response);
}

async function updateAgentTarget(request, response) {
  checkRateLimit(request, "command", COMMAND_RATE_LIMIT);
  const body = await readJson(request, MAX_JSON_BYTES);
  const target = await agentStore.setActiveTarget(body.target || body);
  json(response, 200, { target });
}

async function queueAgentCommand(request, response) {
  checkRateLimit(request, "command", COMMAND_RATE_LIMIT);
  const body = await readJson(request, MAX_JSON_BYTES);

  try {
    const text = String(body.text || "");
    const target = body.target
      ? agentStore.normalizeAgentTarget(body.target)
      : await agentStore.getActiveTarget();
    const deliveryPreview = codexBridge.dispatchRoute({ target });
    const command = await agentStore.appendCommand({
      text: codexBridge.agentCommandText(text),
      userText: text,
      input: body.input,
      source: body.source,
      echo: body.echo,
      target,
      status: deliveryPreview.accepted ? "dispatching" : undefined,
    });
    const delivery = codexBridge.dispatch(command);
    const status = delivery.accepted ? "dispatching" : command.status;
    const deliverySummary = {
      provider: command.target?.provider,
      direct: delivery.accepted,
      reason: delivery.reason,
      mode: delivery.mode,
      threadId: delivery.threadId,
    };

    json(response, 202, {
      command: {
        id: command.id,
        status,
        receivedAt: command.receivedAt,
        target: command.target,
        delivery: deliverySummary,
      },
      message: {
        id: command.id,
        status,
        receivedAt: command.receivedAt,
        target: command.target,
        delivery: deliverySummary,
      },
    });
  } catch (error) {
    json(response, 400, { error: error.message || "Unable to queue command." });
  }
}

async function listAgentCommands(request, response, url) {
  const result = await agentStore.readCommands({
    after: url.searchParams.get("after"),
    limit: url.searchParams.get("limit"),
  });

  json(response, 200, {
    cursor: result.cursor,
    total: result.total,
    commands: result.records,
  });
}

async function listAgentEvents(request, response, url) {
  const result = await agentStore.readEvents({
    after: url.searchParams.get("after"),
    limit: url.searchParams.get("limit"),
  });

  json(response, 200, {
    cursor: result.cursor,
    total: result.total,
    events: result.records,
  });
}

async function postAgentEvent(request, response) {
  checkRateLimit(request, "command", COMMAND_RATE_LIMIT);
  const body = await readJson(request, MAX_JSON_BYTES);

  try {
    const event = await agentStore.appendEvent(body);
    json(response, 202, { event });
  } catch (error) {
    json(response, 400, { error: error.message || "Unable to record event." });
  }
}

function truncateMeta(value, maxChars = 300) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function identityText(value, maxChars = 160) {
  const text = String(value || "")
    .replace(/[\0\r\n]+/g, " ")
    .trim();
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function sessionIdentity(request) {
  return {
    version: identityText(APP_VERSION, 40),
    host: identityText(request.headers.host || `${HOST}:${PORT}`, 160),
  };
}

function screenshotMetaHeader(meta) {
  return encodeURIComponent(JSON.stringify(meta));
}

async function sendActiveWindowScreenshot(request, response) {
  checkRateLimit(request, "screenshot", SCREENSHOT_RATE_LIMIT);

  let target;
  let capture;

  try {
    target = await agentStore.getActiveTarget();
    capture = await windowScreenshot.captureForTarget(target);
  } catch (error) {
    throw new HttpError(502, error.message || "Unable to capture the active window.");
  }

  const image = Buffer.from(String(capture.imageBase64 || ""), "base64");
  const isPng = image.length >= 8 && image.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";

  if (!image.length || image.length > MAX_SCREENSHOT_BYTES || !isPng) {
    throw new HttpError(502, "Screenshot capture returned invalid image data.");
  }

  const meta = {
    capturedAt: new Date().toISOString(),
    windowTitle: truncateMeta(capture.windowTitle),
    chatTitle: truncateMeta(capture.chatTitle),
    processName: truncateMeta(capture.processName, 120),
    width: Number(capture.width) || undefined,
    height: Number(capture.height) || undefined,
    target: target
      ? {
          id: truncateMeta(target.id, 180),
          label: truncateMeta(target.label, 180),
          provider: truncateMeta(target.provider, 80),
        }
      : undefined,
  };

  response.writeHead(200, securityHeaders({
    "Content-Type": "image/png",
    "Content-Length": image.length,
    "X-WITS-Screenshot-Meta": screenshotMetaHeader(meta),
  }));
  response.end(image);
}

async function listAgentCatalog(response, url, kind) {
  const options = {
    after: url.searchParams.get("after"),
    limit: url.searchParams.get("limit"),
    project: url.searchParams.get("project"),
  };

  if (kind === "projects") {
    const result = await codexCatalog.listProjects(options);
    json(response, 200, {
      provider: "codex",
      kind,
      ...result,
    });
    return;
  }

  if (kind === "chats") {
    const result = await codexCatalog.listChats(options);
    json(response, 200, {
      provider: "codex",
      kind,
      ...result,
    });
    return;
  }

  json(response, 404, { error: "Unknown catalog kind." });
}

async function serveStatic(request, response, pathname) {
  let relativePath;

  try {
    relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    throw new HttpError(400, "Invalid path.");
  }

  if (relativePath.includes("\0")) {
    throw new HttpError(400, "Invalid path.");
  }

  const filePath = path.resolve(APP_DIR, relativePath);
  const appRoot = path.resolve(APP_DIR);
  const relativeToRoot = path.relative(appRoot, filePath);

  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    text(response, 403, "Forbidden");
    return;
  }

  try {
    const file = await fsp.readFile(filePath);
    response.writeHead(200, securityHeaders({
      "Content-Type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream",
      "Content-Length": file.length,
    }));
    response.end(request.method === "HEAD" ? undefined : file);
  } catch {
    text(response, 404, "Not found");
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/api/session/status") {
      await sessionStatus(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/session/unlock") {
      await unlockSession(request, response);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      authorizeApiRequest(request);
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      const speech = await speechHealth();
      const activeTarget = await agentStore.getActiveTarget();
      json(response, speech.available ? 200 : 503, {
        speech: {
          available: speech.available,
          missing: speech.missing,
          ffmpeg: {
            available: speech.ffmpeg.available,
          },
        },
        tts: {
          available: process.platform === "win32",
          engine: process.platform === "win32" ? "windows-system-speech" : null,
        },
        agent: {
          activeTarget,
          codexDirect: codexBridge.status(),
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/speech/transcribe") {
      await transcribe(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/speech/synthesize") {
      await synthesize(request, response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/screenshot/active-window") {
      await sendActiveWindowScreenshot(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent/target") {
      await getAgentTarget(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/target") {
      await updateAgentTarget(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent/commands") {
      await listAgentCommands(request, response, url);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/commands") {
      await queueAgentCommand(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/agent/events") {
      await listAgentEvents(request, response, url);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/agent/events") {
      await postAgentEvent(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/agent/catalog/")) {
      const kind = url.pathname.slice("/api/agent/catalog/".length);
      await listAgentCatalog(response, url, kind);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/codex/messages") {
      await queueAgentCommand(request, response);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await serveStatic(request, response, url.pathname);
      return;
    }

    text(response, 405, "Method not allowed");
  } catch (error) {
    const status = error.status || 500;

    if (status >= 500) {
      console.error(error);
    }

    json(response, status, {
      error: status >= 500 ? "Server error." : error.message || "Request failed.",
    });
  }
});

validateStartupSecurity();
server.listen(PORT, HOST, () => {
  console.log(`Work in the Sun listening on http://${HOST}:${PORT}`);
  if (PIN_ENABLED) {
    console.log(`Access PIN is enabled. Save it in ${PIN_PATH} or set WITS_ACCESS_PIN.`);
    console.log(`PIN unlock public key fingerprint: ${PIN_KEY_PAIR.fingerprint}`);
  }
  if (ACCESS_TOKEN) {
    console.log(
      PIN_ENABLED
        ? "API access token is minted after a successful PIN unlock."
        : "API access token is enabled. Open the app with #wits_token=... once per browser session.",
    );
  }
});
