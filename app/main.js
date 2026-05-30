const appShell = document.querySelector(".app-shell");
const stateLabel = document.querySelector("#stateLabel");
const stateDetail = document.querySelector("#stateDetail");
const commandButton = document.querySelector("#commandButton");
const recordButton = document.querySelector("#recordButton");
const sendButton = document.querySelector("#sendButton");
const echoToggle = document.querySelector("#echoToggle");
const autoSendToggle = document.querySelector("#autoSendToggle");
const draftText = document.querySelector("#draftText");
const feed = document.querySelector(".feed");
const desktopStatus = document.querySelector("#desktopStatus");

const api = {
  transcribe: "/api/speech/transcribe",
  synthesize: "/api/speech/synthesize",
  sendMessage: "/api/codex/messages",
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
let speechUnlocked = false;

const BrowserSpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
const useBrowserSpeechDemo = new URLSearchParams(window.location.search).has("browserSpeechDemo");
const prefersServerTts = navigator.userAgent.includes("Firefox");

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

function addMessage(text, type = "system") {
  const message = document.createElement("article");
  message.className = `message message-${type}`;

  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  message.append(paragraph);
  feed.append(message);
  feed.scrollTop = feed.scrollHeight;
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

async function setInitialSpeechMode() {
  if (useBrowserSpeechDemo && BrowserSpeechRecognition) {
    stateDetail.textContent = "Browser speech demo ready";
    addMessage("Browser speech demo ready. Desktop adapter still pending.", "system");
    return;
  }

  try {
    const response = await fetch("/api/health");
    const health = await response.json();

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
  const normalized = normalizeCommand(command);

  if (!normalized) {
    setState("idle", "Ready", "Local Dictate ready");
    return;
  }

  if (matchesCommand(normalized, ["send", "send it", "send message", "queue", "queue it", "submit"])) {
    await sendTranscript("command");
    return;
  }

  if (
    matchesCommand(normalized, [
      "clear",
      "clear draft",
      "discard",
      "discard draft",
      "scratch that",
      "delete draft",
    ])
  ) {
    setDraftText("");
    setState("idle", "Ready", "Draft cleared");
    return;
  }

  if (matchesCommand(normalized, ["delete last word", "remove last word"])) {
    deleteLastDraftWord();
    setState("idle", "Ready", getDraftText() ? "Draft edited" : "Draft cleared");
    return;
  }

  if (matchesCommand(normalized, ["echo on", "turn echo on"])) {
    echoToggle.checked = true;
    setState("idle", "Ready", "Echo on");
    return;
  }

  if (matchesCommand(normalized, ["echo off", "turn echo off"])) {
    echoToggle.checked = false;
    setState("idle", "Ready", "Echo off");
    return;
  }

  if (matchesCommand(normalized, ["auto send on", "turn auto send on", "autosend on"])) {
    autoSendToggle.checked = true;
    setState("idle", "Ready", "Auto Send on");
    return;
  }

  if (matchesCommand(normalized, ["auto send off", "turn auto send off", "autosend off"])) {
    autoSendToggle.checked = false;
    setState("idle", "Ready", "Auto Send off");
    return;
  }

  if (matchesCommand(normalized, ["read draft", "read it back", "repeat draft"])) {
    const draft = getDraftText();

    if (draft) {
      await speak(draft);
      setState("idle", "Ready", "Draft read");
    } else {
      setState("idle", "Ready", "No draft");
    }

    return;
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
    setDraftText(replacement);
    setState("idle", "Ready", "Draft replaced");
    return;
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
    appendDraftText(appendText);
    setState("idle", "Ready", "Draft edited");
    return;
  }

  const prependText = commandRemainder(command, ["prepend", "start with", "put before"]);

  if (prependText !== null) {
    prependDraftText(prependText);
    setState("idle", "Ready", "Draft edited");
    return;
  }

  addMessage(`Command not recognized: ${command}`, "warning");
  setState("idle", "Ready", "Command not recognized");
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

async function speak(text) {
  if (prefersServerTts) {
    return speakWithServer(text);
  }

  const browserSpoken = await speakWithBrowser(text);

  if (browserSpoken) {
    return true;
  }

  return speakWithServer(text);
}

async function speakWithBrowser(text) {
  await waitForVoices();

  return new Promise((resolve) => {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      resolve(false);
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
      activeUtterance = null;
      resolve(false);
    }, Math.max(3500, Math.min(12000, text.length * 70)));

    function finish(success) {
      window.clearTimeout(timeout);
      activeUtterance = null;
      resolve(success);
    }

    utterance.addEventListener("start", () => {
      setState("speaking", "Echo", "Reading transcript");
    });
    utterance.addEventListener("end", () => finish(true), { once: true });
    utterance.addEventListener("error", () => finish(false), { once: true });
    window.speechSynthesis.speak(utterance);
  });
}

async function speakWithServer(text) {
  try {
    const response = await fetch(api.synthesize, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      return false;
    }

    const audio = await response.arrayBuffer();
    await playAudioBuffer(audio);
    return true;
  } catch {
    return false;
  }
}

async function playAudioBuffer(audio) {
  if (audioContext) {
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const decoded = await audioContext.decodeAudioData(audio.slice(0));

    await new Promise((resolve) => {
      const source = audioContext.createBufferSource();
      source.buffer = decoded;
      source.connect(audioContext.destination);
      source.addEventListener("ended", resolve, { once: true });
      setState("speaking", "Echo", "Reading transcript");
      source.start();
    });

    return;
  }

  const blob = new Blob([audio], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const player = new Audio(url);

  await new Promise((resolve, reject) => {
    player.addEventListener("playing", () => setState("speaking", "Echo", "Reading transcript"), {
      once: true,
    });
    player.addEventListener("ended", resolve, { once: true });
    player.addEventListener("error", reject, { once: true });
    player.play().catch(reject);
  }).finally(() => URL.revokeObjectURL(url));
}

async function sendTranscript(source = "manual") {
  const text = getDraftText();

  if (!text) {
    setState("idle", "Ready", "No draft");
    return;
  }

  const detail = source === "auto" ? "Auto Send" : "Desktop handoff";
  setState("processing", "Sending", detail);

  try {
    const response = await fetch(api.sendMessage, {
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
    const status = result.message?.status === "queued" ? "Queued on desktop." : "Sent to desktop.";
    addMessage(text, "user");
    addMessage(status, "system");
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
resizeDraft();

window.addEventListener("pagehide", () => {
  stopRecording();
  mediaStream?.getTracks().forEach((track) => track.stop());
});
