const appShell = document.querySelector(".app-shell");
const stateLabel = document.querySelector("#stateLabel");
const stateDetail = document.querySelector("#stateDetail");
const commandButton = document.querySelector("#commandButton");
const recordButton = document.querySelector("#recordButton");
const sendButton = document.querySelector("#sendButton");
const echoToggle = document.querySelector("#echoToggle");
const autoSendToggle = document.querySelector("#autoSendToggle");
const responseAudioToggle = document.querySelector("#responseAudioToggle");
const draftText = document.querySelector("#draftText");
const feed = document.querySelector(".feed");
const desktopStatus = document.querySelector("#desktopStatus");
const agentTargetLabel = document.querySelector("#agentTargetLabel");

const api = {
  transcribe: "/api/speech/transcribe",
  synthesize: "/api/speech/synthesize",
  sendCommand: "/api/agent/commands",
  target: "/api/agent/target",
  events: "/api/agent/events",
};

let mediaRecorder = null;
let mediaStream = null;
let chunks = [];
let startedAt = 0;
let lastTranscript = "";
let wantsRecording = false;
let activeCaptureMode = "dictation";
let activeRecognition = null;
let recognitionTranscript = "";
let activeUtterance = null;
let audioContext = null;
let activeAudioSource = null;
let activeAudioElement = null;
let activeAudioUrl = null;
let activeAudioFinish = null;
let activeSpeechFinish = null;
let audioStopToken = 0;
let speechUnlocked = false;
let responseAudioQueue = Promise.resolve();
let agentEventCursor = 0;

const BrowserSpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
const useBrowserSpeechDemo = new URLSearchParams(window.location.search).has("browserSpeechDemo");
const prefersServerTts = navigator.userAgent.includes("Firefox");
const commandHelp = [
  "send",
  "clear draft",
  "delete last word",
  "echo on / echo off",
  "auto send on / auto send off",
  "responses on / responses off",
  "use codex work in the sun agent chat",
  "use codex work in the sun new",
  "stop audio",
  "read draft",
  "append ...",
  "prepend ...",
  "replace with ...",
  "combine commands with comma, then, or and",
];

function setState(state, label, detail = "", mode = activeCaptureMode) {
  appShell.classList.toggle("is-listening", state === "listening");
  appShell.classList.toggle("is-commanding", state === "listening" && mode === "command");
  appShell.classList.toggle("is-processing", state === "processing");
  appShell.classList.toggle("is-speaking", state === "speaking");
  commandButton.classList.toggle("is-active", state === "listening" && mode === "command");
  recordButton.classList.toggle("is-active", state === "listening" && mode === "dictation");
  stateLabel.textContent = label;
  stateDetail.textContent = detail;
}

function addMessage(text, type = "system", options = {}) {
  const message = document.createElement("article");
  message.className = `message message-${type}`;

  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  message.append(paragraph);
  feed.append(message);
  feed.scrollTop = feed.scrollHeight;

  const shouldSpeak =
    options.speak ?? (responseAudioToggle.checked && ["system", "warning"].includes(type));

  if (shouldSpeak) {
    queueResponseAudio(text);
  }
}

function showCommandHelp() {
  addMessage(`Commands: ${commandHelp.join("; ")}.`, "system");
  setState("idle", "Ready", "Commands listed");
}

function queueResponseAudio(text) {
  const response = text.trim();
  const stopToken = audioStopToken;

  if (!response) {
    return;
  }

  responseAudioQueue = responseAudioQueue
    .catch(() => {})
    .then(() => {
      if (stopToken !== audioStopToken) {
        return "stopped";
      }

      if (!responseAudioToggle.checked) {
        return "skipped";
      }

      return speak(response, "Response", "Reading response");
    })
    .then((spoken) => {
      if (spoken === false) {
        setState("idle", "Ready", "Response audio unavailable");
      }
    });
}

function announceCommand(message, detail = message.replace(/\.$/, "")) {
  addMessage(message, "system");
  setState("idle", "Ready", detail);
}

function stopAudioPlayback({ announce = true } = {}) {
  audioStopToken += 1;
  responseAudioQueue = Promise.resolve();

  if (activeSpeechFinish) {
    activeSpeechFinish("stopped");
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }

  activeUtterance = null;

  if (activeAudioSource) {
    try {
      activeAudioSource.stop(0);
    } catch {
      // Already stopped.
    }

    try {
      activeAudioSource.disconnect();
    } catch {
      // Already disconnected.
    }

    activeAudioSource = null;
  }

  if (activeAudioElement) {
    activeAudioElement.pause();
    activeAudioElement.removeAttribute("src");
    activeAudioElement.load();
    activeAudioElement = null;
  }

  if (activeAudioFinish) {
    activeAudioFinish("stopped");
  }

  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }

  setState("idle", "Ready", "Audio stopped");

  if (announce) {
    addMessage("Audio stopped.", "system", { speak: false });
  }
}

function announceDraftState(detail = "Draft edited") {
  const draft = getDraftText();

  if (!draft) {
    announceCommand("Draft cleared.");
    return;
  }

  addMessage(`Draft: ${draft}`, "system");
  setState("idle", "Ready", detail);
}

function setResponseAudio(enabled, { announce = true } = {}) {
  responseAudioToggle.checked = enabled;
  const message = enabled ? "Responses on." : "Responses off.";
  setState("idle", "Ready", enabled ? "Responses on" : "Responses off");

  if (announce) {
    addMessage(message, "system", { speak: enabled });
  }
}

function getDraftText() {
  return draftText.value.trim();
}

function setDraftText(text, { focus = false } = {}) {
  draftText.value = text;
  lastTranscript = getDraftText();
  sendButton.disabled = !lastTranscript;
  resizeDraft();

  if (focus) {
    draftText.focus();
  }
}

function appendDraftText(text) {
  const current = getDraftText();
  const addition = text.trim();

  if (!addition) {
    return;
  }

  setDraftText(current ? `${current} ${addition}` : addition);
}

function prependDraftText(text) {
  const current = getDraftText();
  const addition = text.trim();

  if (!addition) {
    return;
  }

  setDraftText(current ? `${addition} ${current}` : addition);
}

function deleteLastDraftWord() {
  const current = getDraftText();
  const next = current.replace(/\s*\S+\s*$/, "").trim();
  setDraftText(next);
}

function resizeDraft() {
  draftText.style.height = "auto";
  draftText.style.height = `${Math.min(draftText.scrollHeight, 88)}px`;
}

function titleCase(text) {
  return text
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function renderAgentTarget(target) {
  if (!agentTargetLabel || !target) {
    return;
  }

  agentTargetLabel.textContent = target.label || target.id || "Desktop agent";
  agentTargetLabel.title = [
    target.provider ? `Provider: ${target.provider}` : "",
    target.workspace ? `Workspace: ${target.workspace}` : "",
    target.sessionHint ? `Session: ${target.sessionHint}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function loadAgentTarget() {
  try {
    const response = await fetch(api.target);

    if (!response.ok) {
      return;
    }

    const result = await response.json();
    renderAgentTarget(result.target);
  } catch {
    // The desktop backend status message already covers this case.
  }
}

function parseAgentTargetCommand(command) {
  const match = command.trim().match(/^use\s+([a-z0-9_-]+)\s+(.+)$/i);

  if (!match) {
    return null;
  }

  const provider = match[1].toLowerCase();
  const route = match[2].trim();
  const mode = /\bnew$/i.test(route) ? "new" : "existing";
  const sessionHint = route.replace(/\bnew$/i, "").trim() || "new";

  return {
    provider,
    route,
    sessionHint,
    mode,
    label: `${titleCase(provider)} / ${route}`,
  };
}

async function setAgentTarget(target) {
  setState("processing", "Routing", "Updating agent target");

  try {
    const response = await fetch(api.target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target),
    });

    if (!response.ok) {
      throw new Error("Agent target could not be updated.");
    }

    const result = await response.json();
    renderAgentTarget(result.target);
    announceCommand(`Using ${result.target.label}.`, "Agent target updated");
  } catch (error) {
    addMessage(error.message || "Agent target could not be updated.", "warning");
    setState("idle", "Ready", "Agent target unchanged");
  }
}

function handleAgentEvent(event) {
  const text = String(event.text || "").trim();

  if (!text) {
    return;
  }

  const isWarning = ["warning", "error"].includes(event.level);
  const shouldSpeak = event.speak ?? responseAudioToggle.checked;
  addMessage(text, isWarning ? "warning" : "agent", { speak: shouldSpeak });
}

async function pollAgentEvents() {
  try {
    const response = await fetch(`${api.events}?after=${agentEventCursor}`);

    if (!response.ok) {
      return;
    }

    const result = await response.json();
    agentEventCursor = result.cursor ?? agentEventCursor;
    (result.events || []).forEach(handleAgentEvent);
  } catch {
    // Polling is opportunistic; health checks keep the visible status honest.
  }
}

function startAgentEventPolling() {
  pollAgentEvents();
  window.setInterval(pollAgentEvents, 2400);
}

async function setInitialSpeechMode() {
  if (useBrowserSpeechDemo && BrowserSpeechRecognition) {
    stateDetail.textContent = "Browser speech demo ready";
    addMessage("Browser speech demo ready. Desktop adapter still pending.", "system");
    return;
  }

  try {
    const response = await fetch("/api/health");
    const health = await response.json();

    renderAgentTarget(health.agent?.activeTarget);

    if (response.ok && health.speech?.available) {
      desktopStatus.classList.add("is-online");
      stateDetail.textContent = "Local Dictate ready";
      addMessage("Local Dictate backend ready.", "system");
      return;
    }

    stateDetail.textContent = "Local Dictate missing";
    addMessage("Run the Local Dictate release installer, then restart the backend.", "warning");
  } catch {
    stateDetail.textContent = "Desktop backend pending";
  }
}

async function acceptTranscript(transcript, readyDetail = "Transcript ready") {
  const text = transcript.trim();

  if (!text) {
    addMessage("No speech recognized.", "warning");
    sendButton.disabled = true;
    setState("idle", "Ready", "Try again");
    return;
  }

  setDraftText(text);

  if (echoToggle.checked) {
    const spoken = await speak(text);

    if (!spoken) {
      addMessage("Echo could not start in this browser.", "warning");
    }
  }

  if (autoSendToggle.checked) {
    await sendTranscript("auto");
    return;
  }

  setState("idle", "Ready", readyDetail);
}

function unlockSpeechSynthesis() {
  if (!window.speechSynthesis || speechUnlocked) {
    return;
  }

  speechUnlocked = true;
  window.speechSynthesis.resume();
}

async function unlockAudioOutput() {
  unlockSpeechSynthesis();

  const AudioContext = window.AudioContext || window.webkitAudioContext;

  if (!AudioContext) {
    return;
  }

  if (!audioContext) {
    audioContext = new AudioContext();
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

function getRecorderMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startRecording(mode = "dictation") {
  wantsRecording = true;
  activeCaptureMode = mode;

  if (useBrowserSpeechDemo && startBrowserRecognition(mode)) {
    return;
  }

  if (mediaRecorder?.state === "recording") {
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    addMessage("This browser cannot capture audio here.", "warning");
    return;
  }

  try {
    chunks = [];
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const mimeType = getRecorderMimeType();
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });
    mediaRecorder.addEventListener("stop", handleRecordingStop, { once: true });
    startedAt = Date.now();
    mediaRecorder.start();

    if (!wantsRecording) {
      stopRecording();
      return;
    }

    const label = mode === "command" ? "Command" : "Listening";
    const detail = mode === "command" ? "Listening for UI command" : "Recording locally";
    setState("listening", label, detail, mode);
  } catch (error) {
    addMessage(error.message || "Microphone access failed.", "warning");
    setState("idle", "Ready", "Microphone unavailable");
  }
}

function stopRecording() {
  wantsRecording = false;

  if (activeRecognition) {
    activeRecognition.stop();
    return;
  }

  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
  }
}

function startBrowserRecognition(mode) {
  if (!BrowserSpeechRecognition) {
    return false;
  }

  if (activeRecognition) {
    return true;
  }

  recognitionTranscript = "";
  const recognition = new BrowserSpeechRecognition();
  activeRecognition = recognition;

  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.maxAlternatives = 1;

  recognition.addEventListener("start", () => {
    const label = mode === "command" ? "Command" : "Listening";
    setState("listening", label, "Browser speech demo", mode);
  });

  recognition.addEventListener("result", (event) => {
    let interim = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = result[0]?.transcript || "";

      if (result.isFinal) {
        recognitionTranscript += text;
      } else {
        interim += text;
      }
    }

    const preview = `${recognitionTranscript} ${interim}`.trim();
    stateDetail.textContent = preview || "Listening";
  });

  recognition.addEventListener("error", (event) => {
    const reason = event.error === "not-allowed" ? "Microphone permission denied." : "Browser speech demo failed.";
    addMessage(reason, "warning");
  });

  recognition.addEventListener("end", () => {
    activeRecognition = null;
    handleTranscriptResult(recognitionTranscript, mode, "Browser speech demo");
  });

  try {
    recognition.start();
    return true;
  } catch (error) {
    activeRecognition = null;
    addMessage(error.message || "Browser speech demo failed.", "warning");
    return true;
  }
}

async function handleRecordingStop() {
  const mode = activeCaptureMode;
  const durationMs = Date.now() - startedAt;
  const mimeType = mediaRecorder?.mimeType || "application/octet-stream";
  const audio = new Blob(chunks, { type: mimeType });

  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  mediaRecorder = null;

  if (!audio.size) {
    setState("idle", "Ready", "No audio captured");
    return;
  }

  const label = mode === "command" ? "Command" : "Processing";
  setState("processing", label, `${Math.round(durationMs / 100) / 10}s captured`, mode);

  try {
    const result = await transcribeAudio(audio, { durationMs, mimeType });
    lastTranscript = result.text.trim();

    if (result.blank || !lastTranscript) {
      lastTranscript = getDraftText();
      sendButton.disabled = !lastTranscript;
      setState("idle", "Ready", "Local Dictate ready");
      return;
    }

    await handleTranscriptResult(lastTranscript, mode);
  } catch (error) {
    addMessage(error.message || "Speech adapter is not connected.", "warning");
    sendButton.disabled = !getDraftText();
    setState("idle", "Ready", "Speech adapter pending");
  }
}

async function transcribeAudio(audio, metadata) {
  const response = await fetch(api.transcribe, {
    method: "POST",
    headers: {
      "Content-Type": metadata.mimeType || "application/octet-stream",
      "X-Capture-Duration-Ms": String(metadata.durationMs),
    },
    body: audio,
  });

  if (!response.ok) {
    throw new Error("Speech adapter is not connected.");
  }

  const result = await response.json();
  return {
    text: result.text || "",
    blank: Boolean(result.blank),
  };
}

async function handleTranscriptResult(transcript, mode, readyDetail = "Transcript ready") {
  const text = transcript.trim();

  if (!text) {
    lastTranscript = "";
    sendButton.disabled = !getDraftText();
    setState("idle", "Ready", "Local Dictate ready");
    return;
  }

  if (mode === "command") {
    await applyVoiceCommand(text);
    return;
  }

  await acceptTranscript(text, readyDetail);
}

async function applyVoiceCommand(commandText) {
  const command = commandText.trim();

  if (!command) {
    setState("idle", "Ready", "Local Dictate ready");
    return;
  }

  const parts = splitCommandComposition(command);

  if (parts.length > 1) {
    for (const part of parts) {
      await applySingleVoiceCommand(parseSingleVoiceCommand(part));
    }

    return;
  }

  const action = parseSingleVoiceCommand(command);

  if (action) {
    await applySingleVoiceCommand(action);
    return;
  }

  addMessage(`Command not recognized: ${command}`, "warning");
  setState("idle", "Ready", "Command not recognized");
}

function splitCommandComposition(command) {
  const hardParts = splitCommandParts(command, /\s*(?:[,;]|\band then\b|\bthen\b)\s*/i);

  if (hardParts.length > 1 && hardParts.every((part) => parseSingleVoiceCommand(part))) {
    return hardParts;
  }

  const andParts = splitCommandParts(command, /\s+\band\b\s+/i);

  if (andParts.length > 1 && andParts.every((part) => parseSingleVoiceCommand(part))) {
    return andParts;
  }

  return [command];
}

function splitCommandParts(command, separator) {
  return command
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseSingleVoiceCommand(command) {
  const normalized = normalizeCommand(command);

  if (!normalized) {
    return null;
  }

  const agentTarget = parseAgentTargetCommand(command);

  if (agentTarget) {
    return { type: "setAgentTarget", target: agentTarget };
  }

  const commandGroups = [
    {
      type: "send",
      commands: ["send", "send it", "send message", "queue", "queue it", "submit"],
    },
    {
      type: "clear",
      commands: ["clear", "clear draft", "discard", "discard draft", "scratch that", "delete draft"],
    },
    {
      type: "deleteLastWord",
      commands: ["delete last word", "remove last word"],
    },
    {
      type: "echoOn",
      commands: ["echo on", "turn echo on"],
    },
    {
      type: "echoOff",
      commands: ["echo off", "turn echo off"],
    },
    {
      type: "autoSendOn",
      commands: ["auto send on", "turn auto send on", "autosend on"],
    },
    {
      type: "autoSendOff",
      commands: ["auto send off", "turn auto send off", "autosend off"],
    },
    {
      type: "responsesOn",
      commands: [
        "responses on",
        "response audio on",
        "read responses on",
        "turn responses on",
        "turn response audio on",
      ],
    },
    {
      type: "responsesOff",
      commands: [
        "responses off",
        "response audio off",
        "read responses off",
        "turn responses off",
        "turn response audio off",
      ],
    },
    {
      type: "stopAudio",
      commands: [
        "stop",
        "stop audio",
        "stop speaking",
        "stop reading",
        "stop readback",
        "stop read back",
        "stop talking",
        "silence",
        "quiet",
      ],
    },
    {
      type: "readDraft",
      commands: ["read draft", "read it back", "repeat draft"],
    },
    {
      type: "help",
      commands: ["help", "list commands", "show commands", "what can i say"],
    },
  ];

  for (const group of commandGroups) {
    if (matchesCommand(normalized, group.commands)) {
      return { type: group.type };
    }
  }

  const replacement = commandRemainder(command, [
    "replace draft with",
    "replace message with",
    "replace with",
    "change it to",
    "change to",
    "set draft to",
    "new message",
  ]);

  if (replacement !== null) {
    return { type: "replace", text: replacement };
  }

  const appendText = commandRemainder(command, [
    "append to draft",
    "append to message",
    "add to draft",
    "add to message",
    "append",
    "add",
  ]);

  if (appendText !== null) {
    return { type: "append", text: appendText };
  }

  const prependText = commandRemainder(command, ["prepend", "start with", "put before"]);

  if (prependText !== null) {
    return { type: "prepend", text: prependText };
  }

  return null;
}

async function applySingleVoiceCommand(action) {
  switch (action.type) {
    case "send":
      await sendTranscript("command");
      return;

    case "clear":
      setDraftText("");
      announceCommand("Draft cleared.");
      return;

    case "deleteLastWord":
      deleteLastDraftWord();
      announceDraftState();
      return;

    case "echoOn":
      echoToggle.checked = true;
      announceCommand("Echo on.");
      return;

    case "echoOff":
      echoToggle.checked = false;
      announceCommand("Echo off.");
      return;

    case "autoSendOn":
      autoSendToggle.checked = true;
      announceCommand("Auto Send on.");
      return;

    case "autoSendOff":
      autoSendToggle.checked = false;
      announceCommand("Auto Send off.");
      return;

    case "responsesOn":
      setResponseAudio(true);
      return;

    case "responsesOff":
      setResponseAudio(false);
      return;

    case "setAgentTarget":
      await setAgentTarget(action.target);
      return;

    case "stopAudio":
      stopAudioPlayback();
      return;

    case "readDraft": {
      const draft = getDraftText();

      if (draft) {
        addMessage("Reading draft.", "system", { speak: false });
        await speak(draft);
        setState("idle", "Ready", "Draft read");
      } else {
        announceCommand("No draft.");
      }

      return;
    }

    case "help":
      showCommandHelp();
      return;

    case "replace":
      setDraftText(action.text);
      announceDraftState("Draft replaced");
      return;

    case "append":
      appendDraftText(action.text);
      announceDraftState("Draft edited");
      return;

    case "prepend":
      prependDraftText(action.text);
      announceDraftState("Draft edited");
      return;

    default:
      return;
  }
}

function normalizeCommand(command) {
  return command
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function matchesCommand(normalizedCommand, commands) {
  return commands.some((command) => normalizedCommand === command);
}

function commandRemainder(command, prefixes) {
  for (const prefix of prefixes) {
    const pattern = new RegExp(`^${escapeRegex(prefix)}[\\s,:-]+(.+)$`, "i");
    const match = command.trim().match(pattern);

    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return null;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function waitForVoices() {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve([]);
      return;
    }

    const voices = window.speechSynthesis.getVoices();

    if (voices.length) {
      resolve(voices);
      return;
    }

    const timeout = window.setTimeout(() => {
      window.speechSynthesis.removeEventListener("voiceschanged", handleVoicesChanged);
      resolve(window.speechSynthesis.getVoices());
    }, 500);

    function handleVoicesChanged() {
      window.clearTimeout(timeout);
      window.speechSynthesis.removeEventListener("voiceschanged", handleVoicesChanged);
      resolve(window.speechSynthesis.getVoices());
    }

    window.speechSynthesis.addEventListener("voiceschanged", handleVoicesChanged);
  });
}

async function speak(text, label = "Echo", detail = "Reading transcript") {
  const stopToken = audioStopToken;

  if (prefersServerTts) {
    return speakWithServer(text, label, detail, stopToken);
  }

  const browserSpoken = await speakWithBrowser(text, label, detail, stopToken);

  if (browserSpoken === true) {
    return true;
  }

  if (browserSpoken === "stopped") {
    return "stopped";
  }

  return speakWithServer(text, label, detail, stopToken);
}

async function speakWithBrowser(text, label, detail, stopToken) {
  await waitForVoices();

  return new Promise((resolve) => {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      resolve(false);
      return;
    }

    if (stopToken !== audioStopToken) {
      resolve("stopped");
      return;
    }

    window.speechSynthesis.cancel();
    window.speechSynthesis.resume();
    const utterance = new SpeechSynthesisUtterance(text);
    activeUtterance = utterance;

    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;

    const timeout = window.setTimeout(() => {
      finish(false);
    }, Math.max(3500, Math.min(12000, text.length * 70)));

    function finish(result) {
      window.clearTimeout(timeout);
      if (activeUtterance === utterance) {
        activeUtterance = null;
      }

      if (activeSpeechFinish === finish) {
        activeSpeechFinish = null;
      }

      resolve(result);
    }

    activeSpeechFinish = finish;
    utterance.addEventListener("start", () => {
      setState("speaking", label, detail);
    });
    utterance.addEventListener("end", () => finish(true), { once: true });
    utterance.addEventListener("error", () => finish(false), { once: true });
    window.speechSynthesis.speak(utterance);
  });
}

async function speakWithServer(text, label, detail, stopToken) {
  try {
    if (stopToken !== audioStopToken) {
      return "stopped";
    }

    const response = await fetch(api.synthesize, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (stopToken !== audioStopToken) {
      return "stopped";
    }

    if (!response.ok) {
      return false;
    }

    const audio = await response.arrayBuffer();
    return playAudioBuffer(audio, label, detail, stopToken);
  } catch {
    return false;
  }
}

async function playAudioBuffer(audio, label, detail, stopToken) {
  if (stopToken !== audioStopToken) {
    return "stopped";
  }

  if (audioContext) {
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const decoded = await audioContext.decodeAudioData(audio.slice(0));

    if (stopToken !== audioStopToken) {
      return "stopped";
    }

    return new Promise((resolve) => {
      const source = audioContext.createBufferSource();
      let settled = false;

      function finish(result) {
        if (settled) {
          return;
        }

        settled = true;

        if (activeAudioSource === source) {
          activeAudioSource = null;
        }

        if (activeAudioFinish === finish) {
          activeAudioFinish = null;
        }

        resolve(result);
      }

      source.buffer = decoded;
      source.connect(audioContext.destination);
      activeAudioSource = source;
      activeAudioFinish = finish;
      source.addEventListener("ended", () => finish(true), { once: true });

      if (stopToken !== audioStopToken) {
        finish("stopped");
        return;
      }

      setState("speaking", label, detail);
      try {
        source.start();
      } catch {
        finish(false);
      }
    });
  }

  const blob = new Blob([audio], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const player = new Audio(url);

  activeAudioElement = player;
  activeAudioUrl = url;

  return new Promise((resolve) => {
    let settled = false;

    function finish(result) {
      if (settled) {
        return;
      }

      settled = true;

      if (activeAudioElement === player) {
        activeAudioElement = null;
      }

      if (activeAudioFinish === finish) {
        activeAudioFinish = null;
      }

      if (activeAudioUrl === url) {
        URL.revokeObjectURL(url);
        activeAudioUrl = null;
      }

      resolve(result);
    }

    player.addEventListener("playing", () => setState("speaking", label, detail), {
      once: true,
    });
    player.addEventListener("ended", () => finish(true), { once: true });
    player.addEventListener("error", () => finish(false), { once: true });

    activeAudioFinish = finish;

    if (stopToken !== audioStopToken) {
      finish("stopped");
      return;
    }

    player.play().catch(() => {
      finish(false);
    });
  });
}

async function sendTranscript(source = "manual") {
  const text = getDraftText();

  if (!text) {
    addMessage("No draft.", "system");
    setState("idle", "Ready", "No draft");
    return;
  }

  const detail = source === "auto" ? "Auto Send" : "Desktop handoff";
  setState("processing", "Sending", detail);

  try {
    const response = await fetch(api.sendCommand, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        input: "voice",
        echo: echoToggle.checked,
        source,
      }),
    });

    if (!response.ok) {
      throw new Error("Desktop command route is not connected.");
    }

    const result = await response.json();
    const queued = result.command?.status === "queued" || result.message?.status === "queued";
    const target = result.command?.target || result.message?.target;
    const status = queued ? "Queued for agent." : "Sent to agent.";
    addMessage(text, "user");
    addMessage(status, "system");
    renderAgentTarget(target);
    setDraftText("");
    setState("idle", "Ready", status);
  } catch (error) {
    addMessage(error.message || "Desktop command route is not connected.", "warning");
    setState("idle", "Ready", "Desktop route pending");
  }
}

function bindHoldToRecord(button, mode) {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    unlockAudioOutput().catch(() => {});
    startRecording(mode);
  });

  button.addEventListener("pointerup", (event) => {
    event.preventDefault();
    stopRecording();
  });

  button.addEventListener("pointercancel", stopRecording);
  button.addEventListener("lostpointercapture", stopRecording);
}

bindHoldToRecord(recordButton, "dictation");
bindHoldToRecord(commandButton, "command");
sendButton.addEventListener("click", () => sendTranscript("manual"));
draftText.addEventListener("input", () => {
  lastTranscript = getDraftText();
  sendButton.disabled = !lastTranscript;
  resizeDraft();
});
autoSendToggle.addEventListener("change", () => {
  setState("idle", "Ready", autoSendToggle.checked ? "Auto Send on" : "Auto Send off");
});
responseAudioToggle.addEventListener("change", async () => {
  await unlockAudioOutput();
  setResponseAudio(responseAudioToggle.checked);
});
echoToggle.addEventListener("change", async () => {
  await unlockAudioOutput();

  if (echoToggle.checked) {
    const previousDetail = stateDetail.textContent;
    const spoken = await speak("Echo on");

    if (!spoken) {
      addMessage("Echo is on, but browser speech output did not start.", "warning");
    }

    setState("idle", "Ready", previousDetail || "Local Dictate ready");
  }
});
setInitialSpeechMode();
loadAgentTarget();
startAgentEventPolling();
resizeDraft();

window.addEventListener("pagehide", () => {
  stopRecording();
  mediaStream?.getTracks().forEach((track) => track.stop());
});
