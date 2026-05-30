const appShell = document.querySelector(".app-shell");
const stateLabel = document.querySelector("#stateLabel");
const stateDetail = document.querySelector("#stateDetail");
const recordButton = document.querySelector("#recordButton");
const sendButton = document.querySelector("#sendButton");
const echoToggle = document.querySelector("#echoToggle");
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
let activeRecognition = null;
let recognitionTranscript = "";
let activeUtterance = null;
let audioContext = null;
let speechUnlocked = false;

const BrowserSpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
const useBrowserSpeechDemo = new URLSearchParams(window.location.search).has("browserSpeechDemo");
const prefersServerTts = navigator.userAgent.includes("Firefox");

function setState(state, label, detail = "") {
  appShell.classList.toggle("is-listening", state === "listening");
  appShell.classList.toggle("is-processing", state === "processing");
  appShell.classList.toggle("is-speaking", state === "speaking");
  recordButton.classList.toggle("is-active", state === "listening");
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
  lastTranscript = transcript.trim();

  if (!lastTranscript) {
    addMessage("No speech recognized.", "warning");
    sendButton.disabled = true;
    setState("idle", "Ready", "Try again");
    return;
  }

  addMessage(lastTranscript, "user");
  sendButton.disabled = false;

  if (echoToggle.checked) {
    const spoken = await speak(lastTranscript);

    if (!spoken) {
      addMessage("Echo could not start in this browser.", "warning");
    }
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

async function startRecording() {
  wantsRecording = true;

  if (useBrowserSpeechDemo && startBrowserRecognition()) {
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

    setState("listening", "Listening", "Recording locally");
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

function startBrowserRecognition() {
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
    setState("listening", "Listening", "Browser speech demo");
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
    acceptTranscript(recognitionTranscript, "Browser speech demo");
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

  setState("processing", "Processing", `${Math.round(durationMs / 100) / 10}s captured`);

  try {
    const transcript = await transcribeAudio(audio, { durationMs, mimeType });
    lastTranscript = transcript.trim();

    if (!lastTranscript) {
      addMessage("Speech adapter returned no text.", "warning");
      sendButton.disabled = true;
      setState("idle", "Ready", "Speech adapter pending");
      return;
    }

    await acceptTranscript(lastTranscript);
  } catch (error) {
    addMessage(error.message || "Speech adapter is not connected.", "warning");
    sendButton.disabled = true;
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
  return result.text || "";
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

async function sendTranscript() {
  if (!lastTranscript) {
    return;
  }

  setState("processing", "Sending", "Desktop handoff");

  try {
    const response = await fetch(api.sendMessage, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: lastTranscript,
        input: "voice",
        echo: echoToggle.checked,
      }),
    });

    if (!response.ok) {
      throw new Error("Desktop command route is not connected.");
    }

    const result = await response.json();
    const status = result.message?.status === "queued" ? "Queued on desktop." : "Sent to desktop.";
    addMessage(status, "system");
    sendButton.disabled = true;
    setState("idle", "Ready", status);
  } catch (error) {
    addMessage(error.message || "Desktop command route is not connected.", "warning");
    setState("idle", "Ready", "Desktop route pending");
  }
}

recordButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  recordButton.setPointerCapture(event.pointerId);
  unlockAudioOutput().catch(() => {});
  startRecording();
});

recordButton.addEventListener("pointerup", (event) => {
  event.preventDefault();
  stopRecording();
});

recordButton.addEventListener("pointercancel", stopRecording);
recordButton.addEventListener("lostpointercapture", stopRecording);
sendButton.addEventListener("click", sendTranscript);
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

window.addEventListener("pagehide", () => {
  stopRecording();
  mediaStream?.getTracks().forEach((track) => track.stop());
});
