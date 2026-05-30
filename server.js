const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const agentStore = require("./lib/agent-store");
const codexCatalog = require("./lib/codex-catalog");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const APP_DIR = path.join(__dirname, "app");
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SILENCE_RMS_THRESHOLD = Number(process.env.SILENCE_RMS_THRESHOLD || 0.003);
const SILENCE_PEAK_THRESHOLD = Number(process.env.SILENCE_PEAK_THRESHOLD || 0.02);

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

function json(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
  });
  response.end(payload);
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

    request.on("data", (chunk) => {
      size += chunk.length;

      if (size > maxBytes) {
        reject(new Error("Audio capture is too large."));
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
  const body = await readBody(request, maxBytes);

  if (!body.length) {
    return {};
  }

  return JSON.parse(body.toString("utf8"));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function speechHealth() {
  const localDictate = resolveLocalDictate();
  let ffmpegAvailable = false;

  try {
    await run(FFMPEG, ["-version"]);
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
    await run(FFMPEG, [
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
    ]);

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
      { cwd: localDictate.root },
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
    await run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-Text",
      text,
      "-OutputPath",
      wavPath,
    ]);

    const wav = await fsp.readFile(wavPath);
    response.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": wav.length,
      "Cache-Control": "no-store",
    });
    response.end(wav);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

async function getAgentTarget(response) {
  const target = await agentStore.getActiveTarget();
  json(response, 200, { target });
}

async function updateAgentTarget(request, response) {
  const body = await readJson(request, MAX_JSON_BYTES);
  const target = await agentStore.setActiveTarget(body.target || body);
  json(response, 200, { target });
}

async function queueAgentCommand(request, response) {
  const body = await readJson(request, MAX_JSON_BYTES);

  try {
    const command = await agentStore.appendCommand({
      text: body.text,
      input: body.input,
      source: body.source,
      echo: body.echo,
      target: body.target,
    });

    json(response, 202, {
      command: {
        id: command.id,
        status: command.status,
        receivedAt: command.receivedAt,
        target: command.target,
      },
      message: {
        id: command.id,
        status: command.status,
        receivedAt: command.receivedAt,
        target: command.target,
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
  const body = await readJson(request, MAX_JSON_BYTES);

  try {
    const event = await agentStore.appendEvent(body);
    json(response, 202, { event });
  } catch (error) {
    json(response, 400, { error: error.message || "Unable to record event." });
  }
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
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(APP_DIR, relativePath);
  const appRoot = path.resolve(APP_DIR);

  if (filePath !== appRoot && !filePath.startsWith(`${appRoot}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await fsp.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream",
      "Content-Length": file.length,
    });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      const speech = await speechHealth();
      const activeTarget = await agentStore.getActiveTarget();
      json(response, speech.available ? 200 : 503, {
        speech: {
          available: speech.available,
          root: speech.localDictate.root,
          missing: speech.missing,
          ffmpeg: speech.ffmpeg,
        },
        tts: {
          available: process.platform === "win32",
          engine: process.platform === "win32" ? "windows-system-speech" : null,
        },
        agent: {
          activeTarget,
          commandsPath: agentStore.paths.commands,
          eventsPath: agentStore.paths.events,
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

    response.writeHead(405);
    response.end("Method not allowed");
  } catch (error) {
    json(response, 500, { error: error.message || "Server error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Work in the Sun listening on http://${HOST}:${PORT}`);
});
