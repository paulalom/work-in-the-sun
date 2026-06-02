const appShell = document.querySelector(".app-shell");
const stateLabel = document.querySelector("#stateLabel");
const stateDetail = document.querySelector("#stateDetail");
const commandButton = document.querySelector("#commandButton");
const recordButton = document.querySelector("#recordButton");
const sendButton = document.querySelector("#sendButton");
const echoToggle = document.querySelector("#echoToggle");
const autoSendToggle = document.querySelector("#autoSendToggle");
const responseAudioToggle = document.querySelector("#responseAudioToggle");
const commandModeToggle = document.querySelector("#commandModeToggle");
const draftText = document.querySelector("#draftText");
const feed = document.querySelector(".feed");
const controlDock = document.querySelector(".control-dock");
const desktopStatus = document.querySelector("#desktopStatus");
const stateStage = document.querySelector("#stateStage");
const agentTargetLabel = document.querySelector("#agentTargetLabel");
const pinGate = document.querySelector("#pinGate");
const pinForm = document.querySelector("#pinForm");
const pinInput = document.querySelector("#pinInput");
const pinMessage = document.querySelector("#pinMessage");
const pinSubmitButton = document.querySelector("#pinSubmitButton");
const pinVisibilityButton = document.querySelector("#pinVisibilityButton");
const serverIdentityVersion = document.querySelector("#serverIdentityVersion");
const serverIdentityHost = document.querySelector("#serverIdentityHost");
const serverIdentityFingerprint = document.querySelector("#serverIdentityFingerprint");

const MAX_FEED_MESSAGES = 80;
const MAX_FEED_MESSAGE_CHARS = 1200;
const FEED_TRUNCATION_SUFFIX = "...";

let startupSecurityMessage = "";
let accessToken = readAccessToken();
const api = {
  sessionStatus: "/api/session/status",
  sessionUnlock: "/api/session/unlock",
  transcribe: "/api/speech/transcribe",
  synthesize: "/api/speech/synthesize",
  sendCommand: "/api/agent/commands",
  screenshot: "/api/screenshot/active-window",
  target: "/api/agent/target",
  events: "/api/agent/events",
  catalog: "/api/agent/catalog",
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
let activeListContext = null;
let lastListedChats = [];
let appStarted = false;
let currentPinUnlock = null;
let currentServerIdentity = {};
let controlDockResizeObserver = null;
let pinUnlockInFlight = false;
let screenshotObjectUrls = [];

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
  "commands on / commands off",
  "list",
  "list projects / list chats",
  "list work in the sun",
  "list chats in work in the sun",
  "continue",
  "use one / use listed one",
  "screenshot",
  "use codex work in the sun agent chat",
  "use codex work in the sun new",
  "stop audio",
  "read draft",
  "append ...",
  "prepend ...",
  "replace with ...",
  "combine commands with comma, then, or and",
];

function readAccessToken() {
  const names = ["wits_token", "access_token", "token"];
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = names.map((name) => searchParams.get(name) || hashParams.get(name)).find(Boolean);

  if (token) {
    if (!isSafePinTransport()) {
      startupSecurityMessage = "Remote unlock requires HTTPS. The URL token was ignored.";
      names.forEach((name) => {
        searchParams.delete(name);
        hashParams.delete(name);
      });
      const nextSearch = searchParams.toString();
      const nextHash = hashParams.toString();
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${
        nextHash ? `#${nextHash}` : ""
      }`;
      window.history.replaceState(null, "", nextUrl);
      return "";
    }

    sessionStorage.setItem("witsAccessToken", token);

    names.forEach((name) => {
      searchParams.delete(name);
      hashParams.delete(name);
    });

    const nextSearch = searchParams.toString();
    const nextHash = hashParams.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${
      nextHash ? `#${nextHash}` : ""
    }`;
    window.history.replaceState(null, "", nextUrl);
    return token;
  }

  return sessionStorage.getItem("witsAccessToken") || "";
}

function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});

  if (accessToken) {
    headers.set("X-WITS-Token", accessToken);
  }

  return fetch(url, {
    ...options,
    headers,
  });
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value === "localhost" || value === "::1" || value === "[::1]" || value.startsWith("127.");
}

function isSafePinTransport() {
  return window.isSecureContext || isLoopbackHostname(window.location.hostname);
}

function base64ToBytes(value) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return window.btoa(binary);
}

async function encryptedPinUnlockPayload(pin, pinUnlock) {
  if (!window.crypto?.subtle) {
    throw new Error("Encrypted password unlock is unavailable in this browser.");
  }

  const responseKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const publicKey = await crypto.subtle.importKey(
    "spki",
    base64ToBytes(pinUnlock.publicKey),
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );
  const payload = new TextEncoder().encode(
    JSON.stringify({
      pin,
      responseKey: bytesToBase64(responseKey),
      nonce: bytesToBase64(nonce),
    }),
  );
  const encrypted = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, payload);

  return {
    request: {
      keyFingerprint: pinUnlock.fingerprint,
      encryptedPin: bytesToBase64(new Uint8Array(encrypted)),
    },
    responseKey,
  };
}

async function decryptPinUnlockResponse(result, responseKey) {
  if (!result.encrypted || result.algorithm !== "A256GCM") {
    throw new Error("Encrypted unlock response was not returned.");
  }

  const key = await crypto.subtle.importKey("raw", responseKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(result.iv),
      additionalData: new TextEncoder().encode(result.aad || "work-in-the-sun:pin-unlock:v1"),
    },
    key,
    base64ToBytes(result.ciphertext),
  );

  return JSON.parse(new TextDecoder().decode(decrypted));
}

function validatePinUnlock(pinUnlock) {
  if (!pinUnlock?.encrypted || !pinUnlock.publicKey || !pinUnlock.fingerprint) {
    throw new Error("Encrypted password unlock is not available.");
  }

  const remembered = localStorage.getItem("witsPinKeyFingerprint");

  if (remembered && remembered !== pinUnlock.fingerprint) {
    throw new Error("Server unlock key changed. Check the desktop before entering the password.");
  }
}

function rememberPinFingerprint(pinUnlock) {
  if (pinUnlock?.fingerprint) {
    localStorage.setItem("witsPinKeyFingerprint", pinUnlock.fingerprint);
  }
}

function setIdentityText(element, value, fallback = "-") {
  element.textContent = String(value || "").trim() || fallback;
}

function updateServerIdentityDetail(identity = currentServerIdentity, pinUnlock = currentPinUnlock) {
  setIdentityText(serverIdentityVersion, identity?.version);
  setIdentityText(serverIdentityHost, identity?.host || window.location.host);
  setIdentityText(serverIdentityFingerprint, pinUnlock?.fingerprint);
}

function formatPasswordUnlockError(message) {
  const text = String(message || "").trim();

  if (!text) {
    return "Invalid password.";
  }

  return text
    .replace(/^PIN\b/, "Password")
    .replace(/\bPIN\b/g, "password")
    .replace(/\bpin\b/g, "password");
}

async function loadSessionStatus() {
  const response = await apiFetch(api.sessionStatus);

  if (!response.ok) {
    return {
      pinRequired: false,
      authenticated: false,
    };
  }

  const session = await response.json();
  currentPinUnlock = session.pinUnlock || null;
  currentServerIdentity = session.identity || {};
  updateServerIdentityDetail();

  if (session.pinRequired) {
    validatePinUnlock(currentPinUnlock);
  }

  return session;
}

function showPinGate(message = "") {
  pinGate.hidden = false;
  appShell.setAttribute("aria-hidden", "true");
  updateServerIdentityDetail();
  pinMessage.textContent = message;
  pinMessage.title = message;
  setPinVisibility(false);
  pinInput.value = "";
  window.setTimeout(() => pinInput.focus(), 0);
}

function setPinGateEnabled(enabled) {
  pinInput.disabled = !enabled;
  pinSubmitButton.disabled = !enabled;
  pinVisibilityButton.disabled = !enabled;
}

function hidePinGate() {
  pinGate.hidden = true;
  appShell.removeAttribute("aria-hidden");
  pinMessage.textContent = "";
  pinMessage.title = "";
}

function setPinVisibility(visible) {
  pinInput.type = visible ? "text" : "password";
  pinVisibilityButton.textContent = visible ? "Hide" : "Show";
  pinVisibilityButton.setAttribute("aria-label", visible ? "Hide password" : "Show password");
  pinVisibilityButton.setAttribute("aria-pressed", String(visible));
  pinVisibilityButton.title = visible ? "Hide password" : "Show password";
}

function togglePinVisibility() {
  setPinVisibility(pinInput.type === "password");
  pinInput.focus();
}

async function unlockWithPin(event) {
  event.preventDefault();

  if (pinUnlockInFlight) {
    return;
  }

  const pin = pinInput.value.trim();

  if (!isSafePinTransport()) {
    pinMessage.textContent = "Password unlock requires HTTPS or localhost.";
    return;
  }

  if (!pin) {
    pinMessage.textContent = "Enter the password.";
    pinInput.focus();
    return;
  }

  if (currentPinUnlock?.maxPinChars && pin.length > currentPinUnlock.maxPinChars) {
    pinMessage.textContent = "Password is too long.";
    pinInput.focus();
    return;
  }

  pinMessage.textContent = "Checking password.";
  pinUnlockInFlight = true;
  setPinGateEnabled(false);

  try {
    if (!currentPinUnlock) {
      const session = await loadSessionStatus();
      currentPinUnlock = session.pinUnlock || null;
    }

    validatePinUnlock(currentPinUnlock);
    const unlock = await encryptedPinUnlockPayload(pin, currentPinUnlock);
    const response = await fetch(api.sessionUnlock, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(unlock.request),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      pinInput.value = "";
      pinMessage.textContent =
        result.attemptsRemaining === 0
          ? "Backend is shutting down."
          : formatPasswordUnlockError(result.error);
      pinInput.focus();
      return;
    }

    const decrypted = await decryptPinUnlockResponse(result, unlock.responseKey);
    accessToken = decrypted.accessToken || "";
    sessionStorage.setItem("witsAccessToken", accessToken);
    rememberPinFingerprint(currentPinUnlock);
    hidePinGate();
    startApp();
  } catch (error) {
    pinMessage.textContent = error.message || "Backend unavailable.";
  } finally {
    pinUnlockInFlight = false;

    if (!pinGate.hidden) {
      setPinGateEnabled(true);
    }
  }
}

async function boot() {
  resizeDraft();

  try {
    const session = await loadSessionStatus();

    if (session.pinRequired && !session.authenticated) {
      if (!isSafePinTransport()) {
        setPinGateEnabled(false);
        showPinGate("Password unlock requires HTTPS or localhost.");
        return;
      }

      setPinGateEnabled(true);
      showPinGate(startupSecurityMessage);
      return;
    }
  } catch (error) {
    setPinGateEnabled(false);
    showPinGate(error.message || "Secure unlock is unavailable.");
    return;
  }

  startApp();
}

function startApp() {
  if (appStarted) {
    return;
  }

  appStarted = true;
  setInitialSpeechMode();
  loadAgentTarget();
  startAgentEventPolling();
}

function setState(state, label, detail = "", mode = activeCaptureMode) {
  appShell.classList.toggle("is-listening", state === "listening");
  appShell.classList.toggle("is-commanding", state === "listening" && mode === "command");
  appShell.classList.toggle("is-processing", state === "processing");
  appShell.classList.toggle("is-speaking", state === "speaking");
  commandButton.classList.toggle("is-active", state === "listening" && mode === "command");
  recordButton.classList.toggle("is-active", state === "listening" && mode === "dictation");
  stateLabel.textContent = label;
  stateDetail.textContent = detail;
  updateStateStageSummary(label, detail);
}

function updateStateStageSummary(label = stateLabel.textContent, detail = stateDetail.textContent) {
  const summary = [label, detail].filter(Boolean).join(": ");
  stateStage.title = summary;
  stateStage.dataset.statusTitle = summary;
  stateStage.setAttribute("aria-label", summary);
}

function syncFeedBottomInset() {
  const dockHeight = Math.ceil(controlDock.getBoundingClientRect().height);

  if (dockHeight > 0) {
    document.documentElement.style.setProperty("--control-dock-height", `${dockHeight}px`);
  }
}

function scrollFeedToBottom() {
  syncFeedBottomInset();
  window.requestAnimationFrame(() => {
    feed.scrollTop = feed.scrollHeight;
    window.requestAnimationFrame(() => {
      feed.scrollTop = feed.scrollHeight;
    });
  });
}

function formatFeedMessageText(text) {
  const value = String(text || "");

  if (value.length <= MAX_FEED_MESSAGE_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_FEED_MESSAGE_CHARS - FEED_TRUNCATION_SUFFIX.length).trimEnd()}${FEED_TRUNCATION_SUFFIX}`;
}

function releaseFeedMessageResources(message) {
  message.querySelectorAll("img").forEach((image) => {
    const src = image.getAttribute("src") || "";

    if (!src.startsWith("blob:")) {
      return;
    }

    URL.revokeObjectURL(src);
    screenshotObjectUrls = screenshotObjectUrls.filter((url) => url !== src);
  });
}

function pruneFeedMessages() {
  const messages = Array.from(feed.querySelectorAll(".message"));
  const overflow = messages.length - MAX_FEED_MESSAGES;

  if (overflow <= 0) {
    return;
  }

  messages.slice(0, overflow).forEach((message) => {
    releaseFeedMessageResources(message);
    message.remove();
  });
}

function addMessage(text, type = "system", options = {}) {
  const displayText = formatFeedMessageText(text);
  const message = document.createElement("article");
  message.className = `message message-${type}`;

  const paragraph = document.createElement("p");
  paragraph.textContent = displayText;
  message.append(paragraph);

  if (options.dispatchStatus) {
    const dispatchLabel = options.dispatchLabel || "Sent";
    message.classList.add(`is-${options.dispatchStatus}`);
    message.title = dispatchLabel;
    message.setAttribute("aria-label", `${displayText} (${dispatchLabel})`);

    const accessibleStatus = document.createElement("span");
    accessibleStatus.className = "sr-only";
    accessibleStatus.textContent = ` ${dispatchLabel}.`;
    message.append(accessibleStatus);
  }

  feed.append(message);
  pruneFeedMessages();
  scrollFeedToBottom();

  const shouldSpeak =
    options.speak ?? (responseAudioToggle.checked && ["system", "warning"].includes(type));

  if (shouldSpeak) {
    queueResponseAudio(displayText);
  }
}

function addScreenshotMessage(url, meta = {}) {
  const message = document.createElement("article");
  message.className = "message message-agent message-screenshot";

  const image = document.createElement("img");
  const title = meta.chatTitle || meta.windowTitle || "active window";
  image.src = url;
  image.alt = `Screenshot of ${title}`;
  image.loading = "lazy";
  image.addEventListener("load", scrollFeedToBottom, { once: true });

  const caption = document.createElement("p");
  caption.textContent = meta.chatTitle
    ? `Screenshot: ${meta.chatTitle}`
    : `Screenshot: ${meta.windowTitle || "active window"}`;

  message.append(image, caption);
  feed.append(message);
  pruneFeedMessages();
  scrollFeedToBottom();
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
    const response = await apiFetch(api.target);

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
  const cleaned = extractCommandText(command);
  const words = cleaned.split(/\s+/).filter(Boolean);

  if (words.length < 3 || normalizeCommand(words[0]) !== "use") {
    return null;
  }

  const provider = words[1].toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const route = extractCommandValue(words.slice(2).join(" "));

  if (!provider || !route) {
    return null;
  }

  const normalizedRoute = normalizeCommand(route);
  const mode = normalizedRoute.endsWith(" new") || normalizedRoute === "new" ? "new" : "existing";
  const sessionHint = mode === "new" ? extractCommandValue(route.replace(/\bnew\b$/i, "")) || "new" : route;

  return {
    provider,
    route,
    sessionHint,
    mode,
    label: `${titleCase(provider)} / ${route}`,
  };
}

function parseSpokenNumber(text) {
  const normalized = normalizeCommand(text);
  const candidates = [
    normalized,
    normalized.replace(/^(?:number|chat|listed)\s+/, ""),
    normalized.split(" ").at(-1) || "",
  ].filter(Boolean);
  const words = new Map([
    ["zero", 0],
    ["oh", 0],
    ["o", 0],
    ["one", 1],
    ["first", 1],
    ["won", 1],
    ["two", 2],
    ["second", 2],
    ["to", 2],
    ["too", 2],
    ["three", 3],
    ["third", 3],
    ["four", 4],
    ["fourth", 4],
    ["for", 4],
    ["fore", 4],
    ["five", 5],
    ["fifth", 5],
    ["six", 6],
    ["sixth", 6],
    ["seven", 7],
    ["seventh", 7],
    ["eight", 8],
    ["eighth", 8],
    ["ate", 8],
    ["aid", 8],
    ["nine", 9],
    ["ninth", 9],
    ["niner", 9],
    ["ten", 10],
    ["tenth", 10],
  ]);

  for (const candidate of candidates) {
    if (/^\d+$/.test(candidate)) {
      return Number(candidate);
    }

    if (words.has(candidate)) {
      return words.get(candidate);
    }
  }

  return null;
}

function parseUseListedCommand(command) {
  const value = commandRemainder(command, [
    "use listed chat",
    "use listed",
    "use list",
    "use number",
    "use",
    "select listed chat",
    "select listed",
    "select number",
  ]);

  if (value === null) {
    return null;
  }

  return parseSpokenNumber(value);
}

function parseProjectChatListCommand(command) {
  const project = commandRemainder(command, [
    "list chats in",
    "list chats for",
    "show chats in",
    "show chats for",
    "list conversations in",
    "list conversations for",
    "show conversations in",
    "show conversations for",
    "list in",
    "show in",
  ]);

  if (project !== null) {
    return project;
  }

  const listTarget = commandRemainder(command, ["list", "show"]);
  const normalizedTarget = normalizeCommand(listTarget || "");
  const reservedListTargets = ["projects", "project", "chats", "chat", "conversations"];

  if (
    listTarget !== null &&
    !reservedListTargets.some((target) => normalizedTarget === target || normalizedTarget.startsWith(`${target} `))
  ) {
    return listTarget;
  }

  const cleaned = extractCommandValue(command);

  if (activeListContext?.kind === "choices" && cleaned) {
    return cleaned;
  }

  return null;
}

async function setAgentTarget(target) {
  setState("processing", "Routing", "Updating agent target");

  try {
    const response = await apiFetch(api.target, {
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
    const response = await apiFetch(`${api.events}?after=${agentEventCursor}`);

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

async function primeAgentEventCursor() {
  try {
    const response = await apiFetch(`${api.events}?after=latest&limit=1`);

    if (!response.ok) {
      return;
    }

    const result = await response.json();
    agentEventCursor = result.cursor ?? result.total ?? agentEventCursor;
  } catch {
    // If priming fails, regular polling can still recover later.
  }
}

function startAgentEventPolling() {
  primeAgentEventCursor().finally(() => {
    pollAgentEvents();
    window.setInterval(pollAgentEvents, 2400);
  });
}

function parseScreenshotMeta(response) {
  const encoded = response.headers.get("X-WITS-Screenshot-Meta");

  if (!encoded) {
    return {};
  }

  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch {
    return {};
  }
}

async function responseError(response, fallback) {
  try {
    const result = await response.json();
    return new Error(result.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

async function requestScreenshot() {
  setState("processing", "Screenshot", "Capturing active window");

  try {
    const response = await apiFetch(api.screenshot, { method: "POST" });

    if (!response.ok) {
      throw await responseError(response, "Screenshot capture failed.");
    }

    const meta = parseScreenshotMeta(response);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    screenshotObjectUrls.push(url);

    addScreenshotMessage(url, meta);
    setState("idle", "Ready", "Screenshot captured");
  } catch (error) {
    addMessage(error.message || "Screenshot capture failed.", "warning");
    setState("idle", "Ready", "Screenshot unavailable");
  }
}

function promptListKind() {
  activeListContext = { kind: "choices" };
  announceCommand("Would you like to list projects or chats?", "Choose projects or chats");
}

function listLabels(items, key = "label") {
  return items.map((item) => item[key]).filter(Boolean).join("; ");
}

async function fetchCatalog(kind, options = {}) {
  const params = new URLSearchParams();

  if (options.after !== undefined) {
    params.set("after", String(options.after));
  }

  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }

  if (options.project) {
    params.set("project", options.project);
  }

  const suffix = params.toString() ? `?${params}` : "";
  const response = await apiFetch(`${api.catalog}/${kind}${suffix}`);

  if (!response.ok) {
    throw new Error("Could not load the Codex list.");
  }

  return response.json();
}

async function listProjects() {
  activeListContext = null;
  lastListedChats = [];
  setState("processing", "Listing", "Loading Codex projects");

  try {
    const result = await fetchCatalog("projects", { limit: 25 });
    const names = listLabels(result.projects || []);

    if (!names) {
      announceCommand("No Codex projects found.", "No projects found");
      return;
    }

    addMessage(`Projects: ${names}.`, "system");
    setState("idle", "Ready", `${result.total || 0} projects listed`);
  } catch (error) {
    addMessage(error.message || "Could not load Codex projects.", "warning");
    setState("idle", "Ready", "Project list unavailable");
  }
}

function formatChat(chat, index, start) {
  const number = start + index + 1;
  const prefix = chat.projectLabel ? `${chat.projectLabel}: ` : "";
  return `${number}. ${prefix}${chat.label}`;
}

function listedChatTarget(item) {
  const chat = item.chat;
  const project = chat.projectLabel || "";

  return {
    id: `codex:${chat.id}`,
    provider: "codex",
    label: project ? `${project} / ${chat.label}` : `Codex / ${chat.label}`,
    workspace: chat.workspace || "",
    sessionHint: chat.id,
    mode: "existing",
    route: chat.label,
  };
}

async function useListedChat(number) {
  if (!number) {
    addMessage("Which listed chat should I use?", "warning");
    setState("idle", "Ready", "Say use one");
    return;
  }

  const item = lastListedChats.find((listed) => listed.number === number || listed.position === number);

  if (!item) {
    addMessage("That listed chat is not on the current page.", "warning");
    setState("idle", "Ready", "Listed chat not found");
    return;
  }

  await setAgentTarget(listedChatTarget(item));
}

async function listChats(after = 0, project = "") {
  const scoped = project.trim();
  const loadingDetail = scoped ? `Loading chats in ${scoped}` : "Loading Codex chats";
  setState("processing", "Listing", loadingDetail);

  try {
    const result = await fetchCatalog("chats", { after, limit: 5, project: scoped });
    const chats = result.chats || [];
    const projectLabel = result.project?.label || scoped;

    if (result.projectMissing) {
      activeListContext = { kind: "choices" };
      lastListedChats = [];
      addMessage(`No Codex project matched ${scoped}.`, "warning");
      setState("idle", "Ready", "Project not found");
      return;
    }

    if (!chats.length) {
      activeListContext = null;
      lastListedChats = [];
      announceCommand(
        projectLabel ? `No Codex chats found in ${projectLabel}.` : "No more Codex chats found.",
        "No more chats",
      );
      return;
    }

    const chatText = chats.map((chat, index) => formatChat(chat, index, after)).join("; ");
    const hasMore = result.cursor < result.total;
    activeListContext = hasMore ? { kind: "chats", cursor: result.cursor, project: scoped } : null;
    lastListedChats = chats.map((chat, index) => ({
      chat,
      number: after + index + 1,
      position: index + 1,
    }));
    const label = projectLabel ? `Chats in ${projectLabel}` : "Chats";
    addMessage(`${label}: ${chatText}.${hasMore ? " Say continue for more." : ""}`, "system");
    setState("idle", "Ready", hasMore ? "Say continue for more" : "Chats listed");
  } catch (error) {
    addMessage(error.message || "Could not load Codex chats.", "warning");
    setState("idle", "Ready", "Chat list unavailable");
  }
}

async function continueList() {
  if (activeListContext?.kind === "chats") {
    await listChats(activeListContext.cursor, activeListContext.project || "");
    return;
  }

  promptListKind();
}

async function setInitialSpeechMode() {
  if (useBrowserSpeechDemo && BrowserSpeechRecognition) {
    setState("idle", "Ready", "Browser speech demo ready");
    addMessage("Browser speech demo ready. Desktop adapter still pending.", "system");
    return;
  }

  try {
    const response = await apiFetch("/api/health");
    const health = await response.json();

    renderAgentTarget(health.agent?.activeTarget);

    if (response.ok && health.speech?.available) {
      desktopStatus.classList.add("is-online");
      desktopStatus.title = "Desktop connected";
      desktopStatus.setAttribute("aria-label", "Desktop connected");
      setState("idle", "Ready", "Local Dictate ready");
      return;
    }

    desktopStatus.title = "Desktop connected; speech backend missing";
    desktopStatus.setAttribute("aria-label", "Desktop connected; speech backend missing");
    setState("idle", "Ready", "Local Dictate missing");
    addMessage("Run the Local Dictate release installer, then restart the backend.", "warning");
  } catch {
    desktopStatus.title = "Desktop backend pending";
    desktopStatus.setAttribute("aria-label", "Desktop backend pending");
    setState("idle", "Ready", "Desktop backend pending");
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
  const response = await apiFetch(api.transcribe, {
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
  const command = extractCommandText(commandText);

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
    .map((part) => extractCommandText(part))
    .filter(Boolean);
}

function parseSingleVoiceCommand(command) {
  const cleaned = extractCommandText(command);
  const normalized = normalizeCommand(cleaned);

  if (!normalized) {
    return null;
  }

  const listedChatNumber = parseUseListedCommand(cleaned);

  if (listedChatNumber !== null) {
    return { type: "useListedChat", number: listedChatNumber };
  }

  const agentTarget = parseAgentTargetCommand(cleaned);

  if (agentTarget) {
    return { type: "setAgentTarget", target: agentTarget };
  }

  if (matchesCommand(normalized, ["list", "show list", "what can i list"])) {
    return { type: "listPrompt" };
  }

  if (
    matchesCommand(normalized, ["list projects", "show projects"]) ||
    (activeListContext?.kind === "choices" && matchesCommand(normalized, ["projects", "project"]))
  ) {
    return { type: "listProjects" };
  }

  if (
    matchesCommand(normalized, ["list chats", "show chats", "list conversations", "show conversations"]) ||
    (activeListContext?.kind === "choices" && matchesCommand(normalized, ["chats", "chat", "conversations"]))
  ) {
    return { type: "listChats" };
  }

  if (matchesCommand(normalized, ["continue", "more", "next", "next page"])) {
    return { type: "continueList" };
  }

  const projectChatList = parseProjectChatListCommand(cleaned);

  if (projectChatList) {
    return { type: "listChats", project: projectChatList };
  }

  const commandGroups = [
    {
      type: "send",
      commands: ["send", "send it", "send message", "queue", "queue it", "submit"],
    },
    {
      type: "screenshot",
      commands: [
        "screenshot",
        "screen shot",
        "take screenshot",
        "take screen shot",
        "send screenshot",
        "send a screenshot",
        "send screen shot",
        "send a screen shot",
        "capture screenshot",
        "capture screen shot",
        "capture window",
        "show screen",
        "show active window",
      ],
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
      type: "commandModeOn",
      commands: [
        "commands on",
        "command mode on",
        "text commands on",
        "chat commands on",
        "send commands on",
      ],
    },
    {
      type: "commandModeOff",
      commands: [
        "commands off",
        "command mode off",
        "text commands off",
        "chat commands off",
        "send commands off",
        "messages on",
        "message mode on",
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

  const replacement = commandRemainder(cleaned, [
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

  const appendText = commandRemainder(cleaned, [
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

  const prependText = commandRemainder(cleaned, ["prepend", "start with", "put before"]);

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

    case "screenshot":
      await requestScreenshot();
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

    case "commandModeOn":
      commandModeToggle.checked = true;
      announceCommand("Commands on.", "Text commands on");
      return;

    case "commandModeOff":
      commandModeToggle.checked = false;
      announceCommand("Commands off.", "Text messages on");
      return;

    case "setAgentTarget":
      await setAgentTarget(action.target);
      return;

    case "useListedChat":
      await useListedChat(action.number);
      return;

    case "listPrompt":
      promptListKind();
      return;

    case "listProjects":
      await listProjects();
      return;

    case "listChats":
      await listChats(0, action.project || "");
      return;

    case "continueList":
      await continueList();
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
  return extractCommandValue(command)
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function extractCommandText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b`]/g, "'")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/^[\s.,!?;:]+|[\s.,!?;:]+$/g, "")
    .replace(/\s+/g, " ");
}

function extractCommandValue(text) {
  return extractCommandText(text)
    .replace(/["']/g, "")
    .replace(/[.,!?;:()[\]{}]+/g, " ")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesCommand(normalizedCommand, commands) {
  return commands.some((command) => normalizedCommand === normalizeCommand(command));
}

function commandRemainder(command, prefixes) {
  const cleaned = extractCommandText(command);
  const normalizedCommand = normalizeCommand(cleaned);

  for (const prefix of prefixes) {
    const normalizedPrefix = normalizeCommand(prefix);
    const prefixWords = normalizedPrefix.split(" ").filter(Boolean);

    if (!prefixWords.length) {
      continue;
    }

    if (normalizedCommand.startsWith(`${normalizedPrefix} `)) {
      const value = cleaned.split(/\s+/).slice(prefixWords.length).join(" ");
      const cleanedValue = extractCommandValue(value);

      if (cleanedValue) {
        return cleanedValue;
      }
    }
  }

  return null;
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

    const response = await apiFetch(api.synthesize, {
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

  if (source === "manual" && commandModeToggle.checked) {
    await sendDraftCommand(text);
    return;
  }

  const detail = source === "auto" ? "Auto Send" : "Desktop handoff";
  setState("processing", "Sending", detail);

  try {
    const response = await apiFetch(api.sendCommand, {
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
    const status = queued ? "Queued" : "Sent";
    const dispatchStatus = queued ? "queued" : "sent";
    const dispatchLabel = queued ? "Queued for agent" : "Sent to agent";
    addMessage(text, "user", { dispatchStatus, dispatchLabel });
    renderAgentTarget(target);
    setDraftText("");
    setState("idle", "Ready", status);
  } catch (error) {
    addMessage(error.message || "Desktop command route is not connected.", "warning");
    setState("idle", "Ready", "Desktop route pending");
  }
}

function handleDraftKeyDown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.repeat) {
    return;
  }

  event.preventDefault();

  if (getDraftText()) {
    sendTranscript("manual");
  }
}

async function sendDraftCommand(text) {
  const command = extractCommandText(text);

  if (!command) {
    addMessage("No command.", "system");
    setState("idle", "Ready", "No command");
    return;
  }

  const parts = splitCommandComposition(command);
  const actions = parts.map((part) => parseSingleVoiceCommand(part));

  if (!actions.every(Boolean)) {
    addMessage(`Command not recognized: ${command}`, "warning");
    setState("idle", "Ready", "Command not recognized");
    return;
  }

  if (actions.some((action) => action.type === "send")) {
    addMessage("Commands are on. Turn Commands off to send the draft as a message.", "warning");
    setState("idle", "Ready", "Commands are on");
    return;
  }

  addMessage(command, "user");
  setDraftText("");

  for (const action of actions) {
    await applySingleVoiceCommand(action);
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
draftText.addEventListener("keydown", handleDraftKeyDown);
draftText.addEventListener("input", () => {
  lastTranscript = getDraftText();
  sendButton.disabled = !lastTranscript;
  resizeDraft();
  syncFeedBottomInset();
});
autoSendToggle.addEventListener("change", () => {
  setState("idle", "Ready", autoSendToggle.checked ? "Auto Send on" : "Auto Send off");
});
responseAudioToggle.addEventListener("change", async () => {
  await unlockAudioOutput();
  setResponseAudio(responseAudioToggle.checked);
});
commandModeToggle.addEventListener("change", () => {
  setState("idle", "Ready", commandModeToggle.checked ? "Text commands on" : "Text messages on");
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
pinForm.addEventListener("submit", unlockWithPin);
pinVisibilityButton.addEventListener("click", togglePinVisibility);

if (window.ResizeObserver) {
  controlDockResizeObserver = new ResizeObserver(syncFeedBottomInset);
  controlDockResizeObserver.observe(controlDock);
}

window.addEventListener("resize", syncFeedBottomInset);
syncFeedBottomInset();
updateStateStageSummary();
boot();

window.addEventListener("pagehide", () => {
  stopRecording();
  controlDockResizeObserver?.disconnect();
  mediaStream?.getTracks().forEach((track) => track.stop());
  screenshotObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  screenshotObjectUrls = [];
});
