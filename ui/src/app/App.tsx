import { useQuery, useQueryClient } from "@tanstack/react-query";
import { List, Mic, Send, Square, TerminalSquare } from "lucide-react";
import { PointerEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commandHelp,
  extractCommandText,
  parseSingleVoiceCommand,
  splitCommandComposition,
  type VoiceCommandAction,
} from "../features/commands/commandParser";
import { PinGate } from "../features/session/PinGate";
import {
  decryptPinUnlockResponse,
  encryptedPinUnlockPayload,
  formatPasswordUnlockError,
  gateFromSession,
  isSafePinTransport,
  readAccessToken,
  rememberPinFingerprint,
  validatePinUnlock,
  type PinGateState,
} from "../features/session/sessionCrypto";
import { createApiClient } from "../shared/api/client";
import type {
  AgentTarget,
  CatalogChat,
  FeedMessage,
  FeedMessageType,
  ListedChat,
  ListContext,
  WorkStatus,
  CaptureMode,
} from "../shared/types";

const MAX_FEED_MESSAGES = 80;
const MAX_FEED_MESSAGE_CHARS = 1200;
const FEED_TRUNCATION_SUFFIX = "...";
const DEFAULT_TARGET_LABEL = "Desktop agent";
const BrowserSpeechRecognition =
  typeof window !== "undefined"
    ? ((window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor })
        .SpeechRecognition ||
        (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor })
          .webkitSpeechRecognition ||
        null)
    : null;
const useBrowserSpeechDemo =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("browserSpeechDemo");
const prefersServerTts = typeof navigator !== "undefined" && navigator.userAgent.includes("Firefox");

type SpeechResult = true | false | "stopped";

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0?: {
      transcript?: string;
    };
  }>;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error?: string;
}

export function App() {
  const initialAccess = useMemo(() => readAccessToken(), []);
  const [accessToken, setAccessToken] = useState(initialAccess.token);
  const accessTokenRef = useRef(accessToken);
  const api = useMemo(() => createApiClient(() => accessTokenRef.current), []);
  const queryClient = useQueryClient();
  const [appReady, setAppReady] = useState(false);
  const appStartedRef = useRef(false);
  const bootedRef = useRef(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinResetSignal, setPinResetSignal] = useState(0);
  const [pinGate, setPinGate] = useState<PinGateState>({
    visible: false,
    enabled: false,
    message: "",
    identity: {},
    pinUnlock: null,
  });
  const [status, setStatus] = useState<WorkStatus>({
    state: "idle",
    label: "Ready",
    detail: "Speech adapter pending",
    mode: "dictation",
  });
  const [messages, setMessages] = useState<FeedMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [echoEnabled, setEchoEnabled] = useState(true);
  const [autoSendEnabled, setAutoSendEnabled] = useState(false);
  const [responseAudioEnabled, setResponseAudioEnabled] = useState(false);
  const [commandModeEnabled, setCommandModeEnabled] = useState(false);
  const [desktopStatusTitle, setDesktopStatusTitle] = useState("Desktop connection");
  const [desktopOnline, setDesktopOnline] = useState(false);
  const [agentTargetLabel, setAgentTargetLabel] = useState(DEFAULT_TARGET_LABEL);
  const feedRef = useRef<HTMLElement | null>(null);
  const controlDockRef = useRef<HTMLElement | null>(null);
  const draftTextRef = useRef<HTMLTextAreaElement | null>(null);
  const draftRef = useRef(draft);
  const messagesRef = useRef<FeedMessage[]>([]);
  const echoRef = useRef(echoEnabled);
  const autoSendRef = useRef(autoSendEnabled);
  const responseAudioRef = useRef(responseAudioEnabled);
  const commandModeRef = useRef(commandModeEnabled);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const wantsRecordingRef = useRef(false);
  const activeCaptureModeRef = useRef<CaptureMode>("dictation");
  const activeRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionTranscriptRef = useRef("");
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const activeAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const activeAudioElementRef = useRef<HTMLAudioElement | null>(null);
  const activeAudioUrlRef = useRef<string | null>(null);
  const activeAudioFinishRef = useRef<((result: SpeechResult) => void) | null>(null);
  const activeSpeechFinishRef = useRef<((result: SpeechResult) => void) | null>(null);
  const audioStopTokenRef = useRef(0);
  const speechUnlockedRef = useRef(false);
  const responseAudioQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const agentEventCursorRef = useRef(0);
  const activeListContextRef = useRef<ListContext>(null);
  const lastListedChatsRef = useRef<ListedChat[]>([]);
  const screenshotObjectUrlsRef = useRef<string[]>([]);
  const speechMissingWarningShownRef = useRef(false);

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    draftRef.current = draft;
    resizeDraft();
  }, [draft]);

  useEffect(() => {
    echoRef.current = echoEnabled;
  }, [echoEnabled]);

  useEffect(() => {
    autoSendRef.current = autoSendEnabled;
  }, [autoSendEnabled]);

  useEffect(() => {
    responseAudioRef.current = responseAudioEnabled;
  }, [responseAudioEnabled]);

  useEffect(() => {
    commandModeRef.current = commandModeEnabled;
  }, [commandModeEnabled]);

  const healthQuery = useQuery({
    queryKey: ["health", accessToken],
    enabled: appReady && !(useBrowserSpeechDemo && BrowserSpeechRecognition),
    refetchInterval: 30_000,
    queryFn: () => api.health(),
  });

  const targetQuery = useQuery({
    queryKey: ["agent-target", accessToken],
    enabled: appReady,
    queryFn: () => api.getAgentTarget(),
  });

  useEffect(() => {
    if (!healthQuery.data) {
      return;
    }

    const { response, body } = healthQuery.data;
    renderAgentTarget(body.agent?.activeTarget || undefined);

    if (response.ok && body.speech?.available) {
      setDesktopOnline(true);
      setDesktopStatusTitle("Desktop connected");
      setWorkStatus("idle", "Ready", "Local Dictate ready");
      return;
    }

    if (response.ok) {
      setDesktopOnline(true);
      setDesktopStatusTitle("Desktop connected; speech backend missing");
      setWorkStatus("idle", "Ready", "Local Dictate missing");

      if (!speechMissingWarningShownRef.current) {
        speechMissingWarningShownRef.current = true;
        addMessage("Run the Local Dictate release installer, then restart the backend.", "warning");
      }

      return;
    }

    setDesktopOnline(false);
    setDesktopStatusTitle("Desktop backend pending");
    setWorkStatus("idle", "Ready", "Desktop backend pending");
  }, [healthQuery.data]);

  useEffect(() => {
    if (targetQuery.data) {
      renderAgentTarget(targetQuery.data);
    }
  }, [targetQuery.data]);

  useEffect(() => {
    if (bootedRef.current) {
      return;
    }

    bootedRef.current = true;
    boot().catch((error: unknown) => {
      setPinGate({
        visible: true,
        enabled: false,
        message: error instanceof Error ? error.message : "Secure unlock is unavailable.",
        identity: {},
        pinUnlock: null,
      });
    });
  }, []);

  useEffect(() => {
    if (!appReady) {
      return undefined;
    }

    let cancelled = false;
    let intervalId = 0;

    async function startPolling() {
      try {
        const result = await api.getAgentEvents("latest", 1);
        agentEventCursorRef.current = result.cursor ?? result.total ?? agentEventCursorRef.current;
      } catch {
        // Regular polling can still recover later.
      }

      if (cancelled) {
        return;
      }

      await pollAgentEvents();
      intervalId = window.setInterval(pollAgentEvents, 2400);
    }

    startPolling();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [appReady, accessToken]);

  useEffect(() => {
    const currentIds = new Set(messages.map((message) => message.id));
    messagesRef.current
      .filter((message) => !currentIds.has(message.id))
      .forEach(releaseFeedMessageResources);
    messagesRef.current = messages;

    const feed = feedRef.current;

    if (!feed) {
      return;
    }

    window.requestAnimationFrame(() => {
      feed.scrollTop = feed.scrollHeight;
      window.requestAnimationFrame(() => {
        feed.scrollTop = feed.scrollHeight;
      });
    });
  }, [messages]);

  useEffect(() => {
    syncFeedBottomInset();

    if (!window.ResizeObserver || !controlDockRef.current) {
      window.addEventListener("resize", syncFeedBottomInset);
      return () => window.removeEventListener("resize", syncFeedBottomInset);
    }

    const observer = new ResizeObserver(syncFeedBottomInset);
    observer.observe(controlDockRef.current);
    window.addEventListener("resize", syncFeedBottomInset);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncFeedBottomInset);
    };
  }, []);

  useEffect(() => {
    function cleanup() {
      stopRecording();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenshotObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      screenshotObjectUrlsRef.current = [];
      stopAudioPlayback({ announce: false });
    }

    window.addEventListener("pagehide", cleanup);
    return () => {
      window.removeEventListener("pagehide", cleanup);
      cleanup();
    };
  }, []);

  async function boot() {
    const session = await api.sessionStatus();

    if (session.pinRequired) {
      validatePinUnlock(session.pinUnlock);
    }

    if (session.pinRequired && !session.authenticated) {
      if (!isSafePinTransport()) {
        setPinGate({
          visible: true,
          enabled: false,
          message: "Password unlock requires HTTPS or localhost.",
          identity: session.identity || {},
          pinUnlock: session.pinUnlock || null,
        });
        return;
      }

      setPinGate(gateFromSession(session, initialAccess.startupSecurityMessage));
      return;
    }

    startApp();
  }

  function startApp() {
    if (appStartedRef.current) {
      return;
    }

    appStartedRef.current = true;
    setPinGate((current) => ({ ...current, visible: false, message: "" }));
    setAppReady(true);

    if (useBrowserSpeechDemo && BrowserSpeechRecognition) {
      setWorkStatus("idle", "Ready", "Browser speech demo ready");
      addMessage("Browser speech demo ready. Desktop adapter still pending.", "system");
    }
  }

  async function unlockWithPin(pinValue: string) {
    if (pinBusy) {
      return;
    }

    const pin = pinValue.trim();

    if (!isSafePinTransport()) {
      setPinGateMessage("Password unlock requires HTTPS or localhost.");
      return;
    }

    if (!pin) {
      setPinGateMessage("Enter the password.");
      return;
    }

    if (pinGate.pinUnlock?.maxPinChars && pin.length > pinGate.pinUnlock.maxPinChars) {
      setPinGateMessage("Password is too long.");
      return;
    }

    setPinBusy(true);

    try {
      let pinUnlock = pinGate.pinUnlock;

      if (!pinUnlock) {
        const session = await api.sessionStatus();
        pinUnlock = session.pinUnlock || null;
        setPinGate((current) => ({
          ...current,
          identity: session.identity || current.identity,
          pinUnlock,
        }));
      }

      validatePinUnlock(pinUnlock);

      if (!pinUnlock) {
        throw new Error("Encrypted password unlock is not available.");
      }

      const unlock = await encryptedPinUnlockPayload(pin, pinUnlock);
      const response = await api.unlockSession(unlock.request);
      const result = (await response.json().catch(() => ({}))) as { error?: string; attemptsRemaining?: number };

      if (!response.ok) {
        setPinResetSignal((current) => current + 1);
        setPinGateMessage(
          result.attemptsRemaining === 0
            ? "Backend is shutting down."
            : formatPasswordUnlockError(result.error || "Invalid password."),
        );
        return;
      }

      const decrypted = await decryptPinUnlockResponse(result, unlock.responseKey);
      const nextAccessToken = decrypted.accessToken || "";
      setAccessToken(nextAccessToken);
      sessionStorage.setItem("witsAccessToken", nextAccessToken);
      rememberPinFingerprint(pinUnlock);
      startApp();
    } catch (error) {
      setPinGateMessage(error instanceof Error ? error.message : "Backend unavailable.");
    } finally {
      setPinBusy(false);
    }
  }

  function setPinGateMessage(message: string) {
    setPinGate((current) => ({ ...current, message }));
  }

  function setWorkStatus(state: WorkStatus["state"], label: string, detail = "", mode = activeCaptureModeRef.current) {
    setStatus({ state, label, detail, mode });
  }

  function syncFeedBottomInset() {
    const dockHeight = Math.ceil(controlDockRef.current?.getBoundingClientRect().height || 0);

    if (dockHeight > 0) {
      document.documentElement.style.setProperty("--control-dock-height", `${dockHeight}px`);
    }
  }

  function resizeDraft() {
    const textarea = draftTextRef.current;

    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 88)}px`;
    syncFeedBottomInset();
  }

  function releaseFeedMessageResources(message: FeedMessage) {
    const url = message.screenshotUrl || "";

    if (!url.startsWith("blob:")) {
      return;
    }

    URL.revokeObjectURL(url);
    screenshotObjectUrlsRef.current = screenshotObjectUrlsRef.current.filter((item) => item !== url);
  }

  function addMessage(text: string, type: FeedMessageType = "system", options: Partial<FeedMessage> & { speak?: boolean } = {}) {
    const displayText = formatFeedMessageText(text);
    const message: FeedMessage = {
      id: crypto.randomUUID(),
      type,
      text: displayText,
      dispatchStatus: options.dispatchStatus,
      dispatchLabel: options.dispatchLabel,
      screenshotUrl: options.screenshotUrl,
      screenshotMeta: options.screenshotMeta,
    };

    setMessages((current) => [...current, message].slice(-MAX_FEED_MESSAGES));

    const shouldSpeak = options.speak ?? (responseAudioRef.current && ["system", "warning"].includes(type));

    if (shouldSpeak) {
      queueResponseAudio(displayText);
    }
  }

  function addScreenshotMessage(url: string, meta = {}) {
    addMessage(metaText(meta), "agent", {
      screenshotUrl: url,
      screenshotMeta: meta,
      speak: false,
    });
  }

  function queueResponseAudio(text: string) {
    const response = text.trim();
    const stopToken = audioStopTokenRef.current;

    if (!response) {
      return;
    }

    responseAudioQueueRef.current = responseAudioQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (stopToken !== audioStopTokenRef.current) {
          return "stopped";
        }

        if (!responseAudioRef.current) {
          return "skipped";
        }

        return speak(response, "Response", "Reading response");
      })
      .then((spoken) => {
        if (spoken === false) {
          setWorkStatus("idle", "Ready", "Response audio unavailable");
        }
      });
  }

  function formatFeedMessageText(text: string) {
    const value = String(text || "");

    if (value.length <= MAX_FEED_MESSAGE_CHARS) {
      return value;
    }

    return `${value.slice(0, MAX_FEED_MESSAGE_CHARS - FEED_TRUNCATION_SUFFIX.length).trimEnd()}${FEED_TRUNCATION_SUFFIX}`;
  }

  function announceCommand(message: string, detail = message.replace(/\.$/, "")) {
    addMessage(message, "system");
    setWorkStatus("idle", "Ready", detail);
  }

  function showCommandHelp() {
    addMessage(`Commands: ${commandHelp.join("; ")}.`, "system");
    setWorkStatus("idle", "Ready", "Commands listed");
  }

  function getDraftText() {
    return draftRef.current.trim();
  }

  function setDraftText(text: string) {
    draftRef.current = text;
    setDraft(text);
  }

  function appendDraftText(text: string) {
    const current = draftRef.current.trimEnd();
    setDraftText(current ? `${current} ${text}` : text);
  }

  function prependDraftText(text: string) {
    const current = draftRef.current.trimStart();
    setDraftText(current ? `${text} ${current}` : text);
  }

  function deleteLastDraftWord() {
    setDraftText(draftRef.current.replace(/\s*\S+\s*$/, "").trimEnd());
  }

  function announceDraftState(detail = "Draft edited") {
    const draftText = getDraftText();
    announceCommand(draftText ? `Draft: ${draftText}` : "Draft is empty.", detail);
  }

  function renderAgentTarget(target?: AgentTarget | null) {
    const label = String(target?.label || "").trim();
    setAgentTargetLabel(label || DEFAULT_TARGET_LABEL);
  }

  async function setAgentTarget(target: AgentTarget) {
    setWorkStatus("processing", "Routing", "Updating agent target");

    try {
      const result = await api.setAgentTarget(target);
      renderAgentTarget(result);
      await queryClient.invalidateQueries({ queryKey: ["agent-target"] });
      announceCommand(`Using ${result.label}.`, "Agent target updated");
    } catch (error) {
      addMessage(error instanceof Error ? error.message : "Agent target could not be updated.", "warning");
      setWorkStatus("idle", "Ready", "Agent target unchanged");
    }
  }

  async function pollAgentEvents() {
    try {
      const result = await api.getAgentEvents(agentEventCursorRef.current);
      agentEventCursorRef.current = result.cursor ?? agentEventCursorRef.current;
      (result.events || []).forEach(handleAgentEvent);
    } catch {
      // Polling is opportunistic; health checks keep the visible status honest.
    }
  }

  function handleAgentEvent(event: { text?: string; level?: string; speak?: boolean }) {
    const text = String(event.text || "").trim();

    if (!text) {
      return;
    }

    const isWarning = ["warning", "error"].includes(String(event.level || ""));
    const shouldSpeak = event.speak ?? responseAudioRef.current;
    addMessage(text, isWarning ? "warning" : "agent", { speak: shouldSpeak });
  }

  function promptListKind() {
    activeListContextRef.current = { kind: "choices" };
    announceCommand("Would you like to list projects or chats?", "Choose projects or chats");
  }

  function listLabels(items: Array<{ label?: string }>, key: "label" = "label") {
    return items
      .map((item) => item[key])
      .filter(Boolean)
      .join("; ");
  }

  async function listProjects() {
    activeListContextRef.current = null;
    lastListedChatsRef.current = [];
    setWorkStatus("processing", "Listing", "Loading Codex projects");

    try {
      const result = await api.fetchCatalog("projects", { limit: 25 });
      const names = listLabels(result.projects || []);

      if (!names) {
        announceCommand("No Codex projects found.", "No projects found");
        return;
      }

      addMessage(`Projects: ${names}.`, "system");
      setWorkStatus("idle", "Ready", `${result.total || 0} projects listed`);
    } catch (error) {
      addMessage(error instanceof Error ? error.message : "Could not load Codex projects.", "warning");
      setWorkStatus("idle", "Ready", "Project list unavailable");
    }
  }

  function formatChat(chat: CatalogChat, index: number, start: number) {
    const number = start + index + 1;
    const prefix = chat.projectLabel ? `${chat.projectLabel}: ` : "";
    return `${number}. ${prefix}${chat.label}`;
  }

  function listedChatTarget(item: ListedChat): AgentTarget {
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

  async function useListedChat(number: number | null) {
    if (!number) {
      addMessage("Which listed chat should I use?", "warning");
      setWorkStatus("idle", "Ready", "Say use one");
      return;
    }

    const item = lastListedChatsRef.current.find((listed) => listed.number === number || listed.position === number);

    if (!item) {
      addMessage("That listed chat is not on the current page.", "warning");
      setWorkStatus("idle", "Ready", "Listed chat not found");
      return;
    }

    await setAgentTarget(listedChatTarget(item));
  }

  async function listChats(after = 0, project = "") {
    const scoped = project.trim();
    const loadingDetail = scoped ? `Loading chats in ${scoped}` : "Loading Codex chats";
    setWorkStatus("processing", "Listing", loadingDetail);

    try {
      const result = await api.fetchCatalog("chats", { after, limit: 5, project: scoped });
      const chats = result.chats || [];
      const projectLabel = result.project?.label || scoped;

      if (result.projectMissing) {
        activeListContextRef.current = { kind: "choices" };
        lastListedChatsRef.current = [];
        addMessage(`No Codex project matched ${scoped}.`, "warning");
        setWorkStatus("idle", "Ready", "Project not found");
        return;
      }

      if (!chats.length) {
        activeListContextRef.current = null;
        lastListedChatsRef.current = [];
        announceCommand(
          projectLabel ? `No Codex chats found in ${projectLabel}.` : "No more Codex chats found.",
          "No more chats",
        );
        return;
      }

      const chatText = chats.map((chat, index) => formatChat(chat, index, after)).join("; ");
      const hasMore = result.cursor < result.total;
      activeListContextRef.current = hasMore ? { kind: "chats", cursor: result.cursor, project: scoped } : null;
      lastListedChatsRef.current = chats.map((chat, index) => ({
        chat,
        number: after + index + 1,
        position: index + 1,
      }));
      const label = projectLabel ? `Chats in ${projectLabel}` : "Chats";
      addMessage(`${label}: ${chatText}.${hasMore ? " Say continue for more." : ""}`, "system");
      setWorkStatus("idle", "Ready", hasMore ? "Say continue for more" : "Chats listed");
    } catch (error) {
      addMessage(error instanceof Error ? error.message : "Could not load Codex chats.", "warning");
      setWorkStatus("idle", "Ready", "Chat list unavailable");
    }
  }

  async function continueList() {
    const context = activeListContextRef.current;

    if (context?.kind === "chats") {
      await listChats(context.cursor, context.project || "");
      return;
    }

    promptListKind();
  }

  async function requestScreenshot() {
    setWorkStatus("processing", "Screenshot", "Capturing active window");

    try {
      const { blob, meta } = await api.requestScreenshot();
      const url = URL.createObjectURL(blob);
      screenshotObjectUrlsRef.current.push(url);
      addScreenshotMessage(url, meta);
      setWorkStatus("idle", "Ready", "Screenshot captured");
    } catch (error) {
      addMessage(error instanceof Error ? error.message : "Screenshot capture failed.", "warning");
      setWorkStatus("idle", "Ready", "Screenshot unavailable");
    }
  }

  async function acceptTranscript(transcript: string, readyDetail = "Transcript ready") {
    const text = transcript.trim();

    if (!text) {
      addMessage("No speech recognized.", "warning");
      setWorkStatus("idle", "Ready", "Try again");
      return;
    }

    setDraftText(text);

    if (echoRef.current) {
      const spoken = await speak(text);

      if (!spoken) {
        addMessage("Echo could not start in this browser.", "warning");
      }
    }

    if (autoSendRef.current) {
      await sendTranscript("auto");
      return;
    }

    setWorkStatus("idle", "Ready", readyDetail);
  }

  function unlockSpeechSynthesis() {
    if (!window.speechSynthesis || speechUnlockedRef.current) {
      return;
    }

    speechUnlockedRef.current = true;
    window.speechSynthesis.resume();
  }

  async function unlockAudioOutput() {
    unlockSpeechSynthesis();
    const AudioContextConstructor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
      null;

    if (!AudioContextConstructor) {
      return;
    }

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextConstructor();
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
  }

  function getRecorderMimeType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  async function startRecording(mode: CaptureMode = "dictation") {
    wantsRecordingRef.current = true;
    activeCaptureModeRef.current = mode;

    if (useBrowserSpeechDemo && startBrowserRecognition(mode)) {
      return;
    }

    if (mediaRecorderRef.current?.state === "recording") {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      addMessage("This browser cannot capture audio here.", "warning");
      return;
    }

    try {
      chunksRef.current = [];
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const mimeType = getRecorderMimeType();
      const recorder = new MediaRecorder(mediaStreamRef.current, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      });
      recorder.addEventListener("stop", handleRecordingStop, { once: true });
      startedAtRef.current = Date.now();
      recorder.start();

      if (!wantsRecordingRef.current) {
        stopRecording();
        return;
      }

      const label = mode === "command" ? "Command" : "Listening";
      const detail = mode === "command" ? "Listening for UI command" : "Recording locally";
      setWorkStatus("listening", label, detail, mode);
    } catch (error) {
      addMessage(error instanceof Error ? error.message : "Microphone access failed.", "warning");
      setWorkStatus("idle", "Ready", "Microphone unavailable");
    }
  }

  function stopRecording() {
    wantsRecordingRef.current = false;

    if (activeRecognitionRef.current) {
      activeRecognitionRef.current.stop();
      return;
    }

    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }

  function startBrowserRecognition(mode: CaptureMode) {
    if (!BrowserSpeechRecognition) {
      return false;
    }

    if (activeRecognitionRef.current) {
      return true;
    }

    recognitionTranscriptRef.current = "";
    const recognition = new BrowserSpeechRecognition();
    activeRecognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 1;

    recognition.addEventListener("start", () => {
      const label = mode === "command" ? "Command" : "Listening";
      setWorkStatus("listening", label, "Browser speech demo", mode);
    });

    recognition.addEventListener("result", (event) => {
      const speechEvent = event as SpeechRecognitionEventLike;
      let interim = "";

      for (let index = speechEvent.resultIndex; index < speechEvent.results.length; index += 1) {
        const result = speechEvent.results[index];
        const text = result[0]?.transcript || "";

        if (result.isFinal) {
          recognitionTranscriptRef.current += text;
        } else {
          interim += text;
        }
      }

      const preview = `${recognitionTranscriptRef.current} ${interim}`.trim();
      setStatus((current) => ({ ...current, detail: preview || "Listening" }));
    });

    recognition.addEventListener("error", (event) => {
      const reason =
        (event as SpeechRecognitionErrorEventLike).error === "not-allowed"
          ? "Microphone permission denied."
          : "Browser speech demo failed.";
      addMessage(reason, "warning");
    });

    recognition.addEventListener("end", () => {
      activeRecognitionRef.current = null;
      handleTranscriptResult(recognitionTranscriptRef.current, mode, "Browser speech demo");
    });

    try {
      recognition.start();
      return true;
    } catch (error) {
      activeRecognitionRef.current = null;
      addMessage(error instanceof Error ? error.message : "Browser speech demo failed.", "warning");
      return true;
    }
  }

  async function handleRecordingStop() {
    const mode = activeCaptureModeRef.current;
    const durationMs = Date.now() - startedAtRef.current;
    const mimeType = mediaRecorderRef.current?.mimeType || "application/octet-stream";
    const audio = new Blob(chunksRef.current, { type: mimeType });

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;

    if (!audio.size) {
      setWorkStatus("idle", "Ready", "No audio captured");
      return;
    }

    const label = mode === "command" ? "Command" : "Processing";
    setWorkStatus("processing", label, `${Math.round(durationMs / 100) / 10}s captured`, mode);

    try {
      const result = await api.transcribe(audio, { durationMs, mimeType });
      const transcript = result.text.trim();

      if (result.blank || !transcript) {
        setWorkStatus("idle", "Ready", "Local Dictate ready");
        return;
      }

      await handleTranscriptResult(transcript, mode);
    } catch (error) {
      addMessage(error instanceof Error ? error.message : "Speech adapter is not connected.", "warning");
      setWorkStatus("idle", "Ready", "Speech adapter pending");
    }
  }

  async function handleTranscriptResult(transcript: string, mode: CaptureMode, readyDetail = "Transcript ready") {
    const text = transcript.trim();

    if (!text) {
      setWorkStatus("idle", "Ready", "Local Dictate ready");
      return;
    }

    if (mode === "command") {
      await applyVoiceCommand(text);
      return;
    }

    await acceptTranscript(text, readyDetail);
  }

  async function applyVoiceCommand(commandText: string) {
    const command = extractCommandText(commandText);

    if (!command) {
      setWorkStatus("idle", "Ready", "Local Dictate ready");
      return;
    }

    const context = { activeListContext: activeListContextRef.current };
    const parts = splitCommandComposition(command, context);

    if (parts.length > 1) {
      for (const part of parts) {
        const action = parseSingleVoiceCommand(part, context);

        if (action) {
          await applySingleVoiceCommand(action);
        }
      }

      return;
    }

    const action = parseSingleVoiceCommand(command, context);

    if (action) {
      await applySingleVoiceCommand(action);
      return;
    }

    addMessage(`Command not recognized: ${command}`, "warning");
    setWorkStatus("idle", "Ready", "Command not recognized");
  }

  async function applySingleVoiceCommand(action: VoiceCommandAction) {
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
        setEchoEnabled(true);
        announceCommand("Echo on.");
        return;

      case "echoOff":
        setEchoEnabled(false);
        announceCommand("Echo off.");
        return;

      case "autoSendOn":
        setAutoSendEnabled(true);
        announceCommand("Auto Send on.");
        return;

      case "autoSendOff":
        setAutoSendEnabled(false);
        announceCommand("Auto Send off.");
        return;

      case "responsesOn":
        setResponseAudio(true);
        return;

      case "responsesOff":
        setResponseAudio(false);
        return;

      case "commandModeOn":
        setCommandModeEnabled(true);
        announceCommand("Commands on.", "Text commands on");
        return;

      case "commandModeOff":
        setCommandModeEnabled(false);
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
        const draftText = getDraftText();

        if (draftText) {
          addMessage("Reading draft.", "system", { speak: false });
          await speak(draftText);
          setWorkStatus("idle", "Ready", "Draft read");
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
    }
  }

  function setResponseAudio(enabled: boolean, { announce = true } = {}) {
    setResponseAudioEnabled(enabled);

    if (!enabled) {
      stopAudioPlayback({ announce: false });
    }

    if (announce) {
      addMessage(`Response audio ${enabled ? "on" : "off"}.`, "system", { speak: false });
      setWorkStatus("idle", "Ready", enabled ? "Response audio on" : "Response audio off");
    }
  }

  function stopAudioPlayback({ announce = true } = {}) {
    audioStopTokenRef.current += 1;
    responseAudioQueueRef.current = Promise.resolve();

    if (activeSpeechFinishRef.current) {
      activeSpeechFinishRef.current("stopped");
    }

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    activeUtteranceRef.current = null;

    if (activeAudioSourceRef.current) {
      try {
        activeAudioSourceRef.current.stop(0);
      } catch {
        // Already stopped.
      }

      try {
        activeAudioSourceRef.current.disconnect();
      } catch {
        // Already disconnected.
      }

      activeAudioSourceRef.current = null;
    }

    if (activeAudioElementRef.current) {
      activeAudioElementRef.current.pause();
      activeAudioElementRef.current.removeAttribute("src");
      activeAudioElementRef.current.load();
      activeAudioElementRef.current = null;
    }

    if (activeAudioFinishRef.current) {
      activeAudioFinishRef.current("stopped");
    }

    if (activeAudioUrlRef.current) {
      URL.revokeObjectURL(activeAudioUrlRef.current);
      activeAudioUrlRef.current = null;
    }

    setWorkStatus("idle", "Ready", "Audio stopped");

    if (announce) {
      addMessage("Audio stopped.", "system", { speak: false });
    }
  }

  function waitForVoices() {
    return new Promise<SpeechSynthesisVoice[]>((resolve) => {
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

  async function speak(text: string, label = "Echo", detail = "Reading transcript"): Promise<SpeechResult> {
    const stopToken = audioStopTokenRef.current;

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

  async function speakWithBrowser(text: string, label: string, detail: string, stopToken: number): Promise<SpeechResult> {
    await waitForVoices();

    return new Promise((resolve) => {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        resolve(false);
        return;
      }

      if (stopToken !== audioStopTokenRef.current) {
        resolve("stopped");
        return;
      }

      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
      const utterance = new SpeechSynthesisUtterance(text);
      activeUtteranceRef.current = utterance;
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;

      const timeout = window.setTimeout(() => {
        finish(false);
      }, Math.max(3500, Math.min(12000, text.length * 70)));

      function finish(result: SpeechResult) {
        window.clearTimeout(timeout);

        if (activeUtteranceRef.current === utterance) {
          activeUtteranceRef.current = null;
        }

        if (activeSpeechFinishRef.current === finish) {
          activeSpeechFinishRef.current = null;
        }

        resolve(result);
      }

      activeSpeechFinishRef.current = finish;
      utterance.addEventListener("start", () => setWorkStatus("speaking", label, detail));
      utterance.addEventListener("end", () => finish(true), { once: true });
      utterance.addEventListener("error", () => finish(false), { once: true });
      window.speechSynthesis.speak(utterance);
    });
  }

  async function speakWithServer(text: string, label: string, detail: string, stopToken: number): Promise<SpeechResult> {
    try {
      if (stopToken !== audioStopTokenRef.current) {
        return "stopped";
      }

      const audio = await api.synthesize(text);

      if (stopToken !== audioStopTokenRef.current) {
        return "stopped";
      }

      if (!audio) {
        return false;
      }

      return playAudioBuffer(audio, label, detail, stopToken);
    } catch {
      return false;
    }
  }

  async function playAudioBuffer(audio: ArrayBuffer, label: string, detail: string, stopToken: number): Promise<SpeechResult> {
    if (stopToken !== audioStopTokenRef.current) {
      return "stopped";
    }

    if (audioContextRef.current) {
      if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume();
      }

      const decoded = await audioContextRef.current.decodeAudioData(audio.slice(0));

      if (stopToken !== audioStopTokenRef.current) {
        return "stopped";
      }

      return new Promise((resolve) => {
        const source = audioContextRef.current?.createBufferSource();

        if (!source || !audioContextRef.current) {
          resolve(false);
          return;
        }

        let settled = false;

        function finish(result: SpeechResult) {
          if (settled) {
            return;
          }

          settled = true;

          if (activeAudioSourceRef.current === source) {
            activeAudioSourceRef.current = null;
          }

          if (activeAudioFinishRef.current === finish) {
            activeAudioFinishRef.current = null;
          }

          resolve(result);
        }

        source.buffer = decoded;
        source.connect(audioContextRef.current.destination);
        activeAudioSourceRef.current = source;
        activeAudioFinishRef.current = finish;
        source.addEventListener("ended", () => finish(true), { once: true });

        if (stopToken !== audioStopTokenRef.current) {
          finish("stopped");
          return;
        }

        setWorkStatus("speaking", label, detail);

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
    activeAudioElementRef.current = player;
    activeAudioUrlRef.current = url;

    return new Promise((resolve) => {
      let settled = false;

      function finish(result: SpeechResult) {
        if (settled) {
          return;
        }

        settled = true;

        if (activeAudioElementRef.current === player) {
          activeAudioElementRef.current = null;
        }

        if (activeAudioFinishRef.current === finish) {
          activeAudioFinishRef.current = null;
        }

        if (activeAudioUrlRef.current === url) {
          URL.revokeObjectURL(url);
          activeAudioUrlRef.current = null;
        }

        resolve(result);
      }

      player.addEventListener("playing", () => setWorkStatus("speaking", label, detail), { once: true });
      player.addEventListener("ended", () => finish(true), { once: true });
      player.addEventListener("error", () => finish(false), { once: true });
      activeAudioFinishRef.current = finish;

      if (stopToken !== audioStopTokenRef.current) {
        finish("stopped");
        return;
      }

      player.play().catch(() => finish(false));
    });
  }

  async function sendTranscript(source = "manual") {
    const text = getDraftText();

    if (!text) {
      addMessage("No draft.", "system");
      setWorkStatus("idle", "Ready", "No draft");
      return;
    }

    if (source === "manual" && commandModeRef.current) {
      await sendDraftCommand(text);
      return;
    }

    const detail = source === "auto" ? "Auto Send" : "Desktop handoff";
    setWorkStatus("processing", "Sending", detail);

    try {
      const result = await api.sendCommand({
        text,
        input: "voice",
        echo: echoRef.current,
        source,
      });
      const queued = result.command?.status === "queued" || result.message?.status === "queued";
      const target = result.command?.target || result.message?.target;
      const statusText = queued ? "Queued" : "Sent";
      const dispatchStatus = queued ? "queued" : "sent";
      const dispatchLabel = queued ? "Queued for agent" : "Sent to agent";
      addMessage(text, "user", { dispatchStatus, dispatchLabel });
      renderAgentTarget(target);
      setDraftText("");
      setWorkStatus("idle", "Ready", statusText);
    } catch (error) {
      addMessage(error instanceof Error ? error.message : "Desktop command route is not connected.", "warning");
      setWorkStatus("idle", "Ready", "Desktop route pending");
    }
  }

  async function sendDraftCommand(text: string) {
    const command = extractCommandText(text);

    if (!command) {
      addMessage("No command.", "system");
      setWorkStatus("idle", "Ready", "No command");
      return;
    }

    const context = { activeListContext: activeListContextRef.current };
    const parts = splitCommandComposition(command, context);
    const actions = parts.map((part) => parseSingleVoiceCommand(part, context));

    if (!actions.every(Boolean)) {
      addMessage(`Command not recognized: ${command}`, "warning");
      setWorkStatus("idle", "Ready", "Command not recognized");
      return;
    }

    const parsedActions = actions as VoiceCommandAction[];

    if (parsedActions.some((action) => action.type === "send")) {
      addMessage("Commands are on. Turn Commands off to send the draft as a message.", "warning");
      setWorkStatus("idle", "Ready", "Commands are on");
      return;
    }

    addMessage(command, "user");
    setDraftText("");

    for (const action of parsedActions) {
      await applySingleVoiceCommand(action);
    }
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.repeat) {
      return;
    }

    event.preventDefault();

    if (getDraftText()) {
      sendTranscript("manual");
    }
  }

  function bindHoldStart(event: PointerEvent<HTMLButtonElement>, mode: CaptureMode) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    unlockAudioOutput().catch(() => undefined);
    startRecording(mode);
  }

  function bindHoldEnd(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    stopRecording();
  }

  async function handleEchoChange(checked: boolean) {
    setEchoEnabled(checked);
    await unlockAudioOutput();

    if (checked) {
      const previousDetail = status.detail;
      const spoken = await speak("Echo on");

      if (!spoken) {
        addMessage("Echo is on, but browser speech output did not start.", "warning");
      }

      setWorkStatus("idle", "Ready", previousDetail || "Local Dictate ready");
    }
  }

  async function handleResponseAudioChange(checked: boolean) {
    await unlockAudioOutput();
    setResponseAudio(checked);
  }

  const statusSummary = [status.label, status.detail].filter(Boolean).join(": ");
  const appClassName = [
    "app-shell",
    status.state === "listening" ? "is-listening" : "",
    status.state === "listening" && status.mode === "command" ? "is-commanding" : "",
    status.state === "processing" ? "is-processing" : "",
    status.state === "speaking" ? "is-speaking" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <PinGate gate={pinGate} busy={pinBusy} resetSignal={pinResetSignal} onSubmit={unlockWithPin} />

      <main className={appClassName} aria-hidden={pinGate.visible ? "true" : undefined}>
        <header className="top-bar">
          <div>
            <p className="kicker">Work in the Sun</p>
            <h1>Voice Console</h1>
          </div>
          <div className="top-status">
            <div
              className={`desktop-status ${desktopOnline ? "is-online" : ""}`}
              aria-label={desktopStatusTitle}
              title={desktopStatusTitle}
            >
              <span className="status-dot" aria-hidden="true" />
              <span>Desktop</span>
            </div>
            <section className="stage" aria-live="polite" role="status" tabIndex={0} data-status-title={statusSummary} aria-label={statusSummary}>
              <div className="pulse" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <p className="state-label">{status.label}</p>
              <p className="state-detail">{status.detail}</p>
            </section>
          </div>
        </header>

        <section className="target-strip" aria-live="polite">
          <span>Agent</span>
          <strong>{agentTargetLabel}</strong>
        </section>

        <section className="feed" aria-label="Session" ref={feedRef}>
          {messages.map((message) => (
            <article
              className={[
                "message",
                `message-${message.type}`,
                message.screenshotUrl ? "message-screenshot" : "",
                message.dispatchStatus ? `is-${message.dispatchStatus}` : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={message.id}
              title={message.dispatchLabel}
              aria-label={message.dispatchLabel ? `${message.text} (${message.dispatchLabel})` : undefined}
            >
              {message.screenshotUrl ? (
                <>
                  <img
                    src={message.screenshotUrl}
                    alt={`Screenshot of ${message.screenshotMeta?.chatTitle || message.screenshotMeta?.windowTitle || "active window"}`}
                    onLoad={() => {
                      const feed = feedRef.current;
                      if (feed) {
                        feed.scrollTop = feed.scrollHeight;
                      }
                    }}
                  />
                  <p>{message.text}</p>
                </>
              ) : (
                <p>{message.text}</p>
              )}
              {message.dispatchLabel ? <span className="sr-only"> {message.dispatchLabel}.</span> : null}
            </article>
          ))}
        </section>

        <footer className="control-dock" ref={controlDockRef}>
          <div className="draft-panel">
            <label className="sr-only" htmlFor="draftText">
              Draft message
            </label>
            <textarea
              ref={draftTextRef}
              id="draftText"
              rows={2}
              placeholder="Draft message"
              value={draft}
              onChange={(event) => setDraftText(event.target.value)}
              onKeyDown={handleDraftKeyDown}
            />
          </div>

          <div className="toggle-row">
            <ToggleControl label="Echo" checked={echoEnabled} onChange={handleEchoChange} />
            <ToggleControl
              label="Auto Send"
              checked={autoSendEnabled}
              onChange={(checked) => {
                setAutoSendEnabled(checked);
                setWorkStatus("idle", "Ready", checked ? "Auto Send on" : "Auto Send off");
              }}
            />
            <ToggleControl label="Responses" checked={responseAudioEnabled} onChange={handleResponseAudioChange} />
            <ToggleControl
              label="Commands"
              checked={commandModeEnabled}
              onChange={(checked) => {
                setCommandModeEnabled(checked);
                setWorkStatus("idle", "Ready", checked ? "Text commands on" : "Text messages on");
              }}
            />
          </div>

          <div className="button-row">
            <button
              className={`command-button icon-button ${status.state === "listening" && status.mode === "command" ? "is-active" : ""}`}
              type="button"
              aria-label="Voice command"
              title="Voice command"
              onPointerDown={(event) => bindHoldStart(event, "command")}
              onPointerUp={bindHoldEnd}
              onPointerCancel={stopRecording}
              onLostPointerCapture={stopRecording}
            >
              <List aria-hidden="true" />
            </button>

            <button
              className={`record-button icon-button ${status.state === "listening" && status.mode === "dictation" ? "is-active" : ""}`}
              type="button"
              aria-label="Push to talk"
              title="Push to talk"
              onPointerDown={(event) => bindHoldStart(event, "dictation")}
              onPointerUp={bindHoldEnd}
              onPointerCancel={stopRecording}
              onLostPointerCapture={stopRecording}
            >
              {status.state === "listening" && status.mode === "dictation" ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
            </button>

            <button className="send-button" type="button" disabled={!draft.trim()} onClick={() => sendTranscript("manual")}>
              <Send aria-hidden="true" />
              <span>Send</span>
            </button>
          </div>
        </footer>
      </main>
    </>
  );
}

function ToggleControl({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void | Promise<void>;
}) {
  return (
    <label className="toggle-control">
      <input type="checkbox" checked={checked} onChange={(event) => void onChange(event.target.checked)} />
      <span className="switch" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

function metaText(meta: { chatTitle?: string; windowTitle?: string }) {
  return meta.chatTitle ? `Screenshot: ${meta.chatTitle}` : `Screenshot: ${meta.windowTitle || "active window"}`;
}
