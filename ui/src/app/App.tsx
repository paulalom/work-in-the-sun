import { useQuery, useQueryClient } from "@tanstack/react-query";
import { List, LoaderCircle, Menu, Mic, Send, Square } from "lucide-react";
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
  AgentEvent,
  AgentTarget,
  CatalogChat,
  CatalogProject,
  FeedMessage,
  FeedMessageType,
  ListedChat,
  ListedProject,
  ListContext,
  ScreenshotMeta,
  WorkStatus,
  CaptureMode,
} from "../shared/types";
import { stopAppAudio, type SpeechResult } from "./audioPlayback";

const MAX_FEED_MESSAGES_PER_THREAD = 30;
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
const MIN_BROWSER_TTS_WATCHDOG_MS = 3500;
const MAX_BROWSER_TTS_WATCHDOG_MS = 60000;
const THREAD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RECENT_THREAD_LIMIT = 8;
export const GLOBAL_FEED_KEY = "global";
const UNCATEGORIZED_THREAD_LABEL = "Uncategorized";
const TARGET_SWITCH_NOTICE_PATTERN = /^Using .+\.$/;
const CATALOG_PAGE_LIMIT = 5;

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

function threadIdFromTarget(target?: AgentTarget | null) {
  const candidates = [target?.sessionHint, target?.id, target?.route, target?.label].filter(Boolean).map(String);

  for (const candidate of candidates) {
    const match = candidate.match(THREAD_ID_PATTERN);

    if (match) {
      return match[0];
    }
  }

  return "";
}

function normalizeFeedKeyPart(value?: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

function isCurrentTarget(target?: AgentTarget | null) {
  return [target?.route, target?.sessionHint, target?.label].some((value) => /^current$/i.test(String(value || "")));
}

function hasConcreteThreadId(target?: AgentTarget | null) {
  return Boolean(threadIdFromTarget(target));
}

export function feedKeyFromTarget(target?: AgentTarget | null) {
  if (!target) {
    return GLOBAL_FEED_KEY;
  }

  const provider = normalizeFeedKeyPart(target.provider || "agent");
  const threadId = threadIdFromTarget(target);

  if (threadId) {
    return `${provider}:thread:${threadId}`;
  }

  if (target.mode === "new") {
    return GLOBAL_FEED_KEY;
  }

  if (isCurrentTarget(target)) {
    return GLOBAL_FEED_KEY;
  }

  return [
    provider,
    "route",
    normalizeFeedKeyPart(target.workspace || ""),
    normalizeFeedKeyPart(target.route || target.sessionHint || target.label || "current"),
  ].join(":");
}

export function feedKeyFromAgentEvent(
  event: Pick<AgentEvent, "commandId" | "target">,
  commandFeedKeys: Record<string, string> = {},
) {
  const targetFeedKey = event.target ? feedKeyFromTarget(event.target) : "";

  if (hasConcreteThreadId(event.target)) {
    return targetFeedKey;
  }

  const commandFeedKey = event.commandId ? commandFeedKeys[event.commandId] : "";
  return commandFeedKey || targetFeedKey || GLOBAL_FEED_KEY;
}

export function draftWithAppendedText(currentDraft: string, nextText: string) {
  const current = currentDraft.trimEnd();
  const next = nextText.trim();

  if (!next) {
    return current;
  }

  return current ? `${current} ${next}` : next;
}

export function draftWithDictationText(currentDraft: string, nextText: string, appendEnabled: boolean) {
  return appendEnabled ? draftWithAppendedText(currentDraft, nextText) : nextText.trim();
}

function feedKeyFromMessage(message: FeedMessage) {
  return message.feedKey || GLOBAL_FEED_KEY;
}

function pruneFeedMessages(messages: FeedMessage[]) {
  const counts = new Map<string, number>();
  const kept: FeedMessage[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const feedKey = feedKeyFromMessage(message);
    const count = counts.get(feedKey) || 0;

    if (count >= MAX_FEED_MESSAGES_PER_THREAD) {
      continue;
    }

    counts.set(feedKey, count + 1);
    kept.push(message);
  }

  return kept.reverse();
}

function isTargetSwitchNotice(message: FeedMessage) {
  return message.type === "system" && TARGET_SWITCH_NOTICE_PATTERN.test(message.text);
}

function withoutTargetSwitchNotices(messages: FeedMessage[]) {
  return messages.filter((message) => !isTargetSwitchNotice(message));
}

function feedMessageCount(messages: FeedMessage[], feedKey: string) {
  return messages.filter((message) => feedKeyFromMessage(message) === feedKey).length;
}

function formatThreadAge(value?: string) {
  const timestamp = Date.parse(value || "");

  if (!timestamp) {
    return "";
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));

  if (elapsedSeconds < 60) {
    return "now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);

  if (elapsedHours < 24) {
    return `${elapsedHours}h`;
  }

  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp));
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
  const [echoEnabled, setEchoEnabled] = useState(false);
  const [autoSendEnabled, setAutoSendEnabled] = useState(false);
  const [appendDictationEnabled, setAppendDictationEnabled] = useState(true);
  const [responseAudioEnabled, setResponseAudioEnabled] = useState(false);
  const [commandModeEnabled, setCommandModeEnabled] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [selectedFeedKey, setSelectedFeedKey] = useState("");
  const [feedActivity, setFeedActivity] = useState<Record<string, { lastAnyAt?: number; lastUserAt?: number }>>({});
  const [threadOrder, setThreadOrder] = useState<Record<string, number>>({});
  const [desktopStatusTitle, setDesktopStatusTitle] = useState("Desktop connection");
  const [desktopOnline, setDesktopOnline] = useState(false);
  const [activeAgentTarget, setActiveAgentTarget] = useState<AgentTarget | null>(null);
  const [agentTargetLabel, setAgentTargetLabel] = useState(DEFAULT_TARGET_LABEL);
  const activeTargetFeedKey = feedKeyFromTarget(activeAgentTarget);
  const activeFeedKey = selectedFeedKey || activeTargetFeedKey;
  const visibleMessages = messages.filter((message) => feedKeyFromMessage(message) === activeFeedKey);
  const feedRef = useRef<HTMLElement | null>(null);
  const controlDockRef = useRef<HTMLElement | null>(null);
  const draftTextRef = useRef<HTMLTextAreaElement | null>(null);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(draft);
  const messagesRef = useRef<FeedMessage[]>([]);
  const activeAgentTargetRef = useRef<AgentTarget | null>(activeAgentTarget);
  const activeTargetFeedKeyRef = useRef(activeTargetFeedKey);
  const activeFeedKeyRef = useRef(activeFeedKey);
  const selectedFeedKeyRef = useRef(selectedFeedKey);
  const nextThreadOrderRef = useRef(0);
  const commandFeedKeysRef = useRef<Record<string, string>>({});
  const echoRef = useRef(echoEnabled);
  const autoSendRef = useRef(autoSendEnabled);
  const appendDictationRef = useRef(appendDictationEnabled);
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
  const lastListedProjectsRef = useRef<ListedProject[]>([]);
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
    appendDictationRef.current = appendDictationEnabled;
  }, [appendDictationEnabled]);

  useEffect(() => {
    responseAudioRef.current = responseAudioEnabled;
  }, [responseAudioEnabled]);

  useEffect(() => {
    commandModeRef.current = commandModeEnabled;
  }, [commandModeEnabled]);

  useEffect(() => {
    activeFeedKeyRef.current = activeFeedKey;
  }, [activeFeedKey]);

  useEffect(() => {
    activeTargetFeedKeyRef.current = activeTargetFeedKey;
  }, [activeTargetFeedKey]);

  useEffect(() => {
    selectedFeedKeyRef.current = selectedFeedKey;
  }, [selectedFeedKey]);

  useEffect(() => {
    activeAgentTargetRef.current = activeAgentTarget;
  }, [activeAgentTarget]);

  useEffect(() => {
    if (!settingsMenuOpen) {
      return undefined;
    }

    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target;

      if (target instanceof Node && settingsMenuRef.current?.contains(target)) {
        return;
      }

      setSettingsMenuOpen(false);
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setSettingsMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settingsMenuOpen]);

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

  const recentChatsQuery = useQuery({
    queryKey: ["recent-chats", accessToken],
    enabled: appReady,
    refetchInterval: 10_000,
    queryFn: () => api.fetchCatalog("chats", { limit: RECENT_THREAD_LIMIT }),
  });

  useEffect(() => {
    const chats = recentChatsQuery.data?.chats || [];

    if (!chats.length) {
      return;
    }

    setThreadOrder((current) => {
      let changed = false;
      const next = { ...current };

      for (const chat of chats) {
        const feedKey = feedKeyFromTarget(chatTarget(chat));

        if (next[feedKey] !== undefined) {
          continue;
        }

        next[feedKey] = nextThreadOrderRef.current;
        nextThreadOrderRef.current += 1;
        changed = true;
      }

      return changed ? next : current;
    });
  }, [recentChatsQuery.data?.chats]);

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
  }, [messages, visibleMessages.length, activeFeedKey]);

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

  function recordFeedActivity(feedKey: string, messageType: FeedMessageType) {
    const now = Date.now();

    setFeedActivity((current) => {
      const previous = current[feedKey] || {};

      return {
        ...current,
        [feedKey]: {
          lastAnyAt: now,
          lastUserAt: messageType === "user" ? now : previous.lastUserAt,
        },
      };
    });
  }

  function addMessage(
    text: string,
    type: FeedMessageType = "system",
    options: Partial<FeedMessage> & { speak?: boolean; target?: AgentTarget | null } = {},
  ) {
    const displayText = formatFeedMessageText(text);
    const feedKey = options.feedKey || (options.target ? feedKeyFromTarget(options.target) : activeFeedKeyRef.current);
    const message: FeedMessage = {
      id: crypto.randomUUID(),
      feedKey,
      type,
      text: displayText,
      dispatchStatus: options.dispatchStatus,
      dispatchLabel: options.dispatchLabel,
      screenshotUrl: options.screenshotUrl,
      screenshotMeta: options.screenshotMeta,
    };

    setMessages((current) => pruneFeedMessages([...current, message]));
    recordFeedActivity(feedKey, type);

    const shouldSpeak = options.speak ?? (responseAudioRef.current && ["system", "warning"].includes(type));

    if (shouldSpeak) {
      queueResponseAudio(displayText);
    }
  }

  function addScreenshotMessage(url: string, meta: ScreenshotMeta = {}) {
    addMessage(metaText(meta), "agent", {
      screenshotUrl: url,
      screenshotMeta: meta,
      target: meta.target,
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
    setDraftText(draftWithAppendedText(draftRef.current, text));
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

  function clearTransientCommandState() {
    activeListContextRef.current = null;
    lastListedChatsRef.current = [];
    lastListedProjectsRef.current = [];
  }

  function rememberCommandFeedKey(commandId: string | undefined, feedKey: string) {
    const id = String(commandId || "").trim();

    if (!id) {
      return;
    }

    commandFeedKeysRef.current[id] = feedKey;
  }

  function rekeyCommandFeedKeys(fromFeedKey: string, toFeedKey: string) {
    for (const [commandId, feedKey] of Object.entries(commandFeedKeysRef.current)) {
      if (feedKey === fromFeedKey) {
        commandFeedKeysRef.current[commandId] = toFeedKey;
      }
    }
  }

  function rekeyFeedMessages(fromFeedKey: string, toFeedKey: string) {
    if (!fromFeedKey || !toFeedKey || fromFeedKey === toFeedKey) {
      return;
    }

    rekeyCommandFeedKeys(fromFeedKey, toFeedKey);
    setMessages((current) =>
      current.map((message) => (feedKeyFromMessage(message) === fromFeedKey ? { ...message, feedKey: toFeedKey } : message)),
    );
    setFeedActivity((current) => {
      const previous = current[fromFeedKey];

      if (!previous) {
        return current;
      }

      const next = { ...current };
      const target = next[toFeedKey] || {};
      next[toFeedKey] = {
        lastAnyAt: Math.max(target.lastAnyAt || 0, previous.lastAnyAt || 0) || undefined,
        lastUserAt: Math.max(target.lastUserAt || 0, previous.lastUserAt || 0) || undefined,
      };
      delete next[fromFeedKey];
      return next;
    });

    if (selectedFeedKeyRef.current === fromFeedKey) {
      selectedFeedKeyRef.current = toFeedKey;
      activeFeedKeyRef.current = toFeedKey;
      setSelectedFeedKey(toFeedKey);
    }
  }

  function renderAgentTarget(target?: AgentTarget | null, options: { clearCommands?: boolean } = {}) {
    const nextTarget = target || null;
    const nextFeedKey = feedKeyFromTarget(nextTarget);
    const previousTargetFeedKey = activeTargetFeedKeyRef.current;
    const label = String(target?.label || "").trim();

    if (options.clearCommands && nextFeedKey !== activeFeedKeyRef.current) {
      clearTransientCommandState();
    }

    if (!selectedFeedKeyRef.current || selectedFeedKeyRef.current === previousTargetFeedKey || options.clearCommands) {
      selectedFeedKeyRef.current = nextFeedKey;
      activeFeedKeyRef.current = nextFeedKey;
      setSelectedFeedKey(nextFeedKey);
    }

    activeTargetFeedKeyRef.current = nextFeedKey;
    activeAgentTargetRef.current = nextTarget;
    setActiveAgentTarget(nextTarget);
    setAgentTargetLabel(label || DEFAULT_TARGET_LABEL);
  }

  async function setAgentTarget(target: AgentTarget) {
    setWorkStatus("processing", "Routing", "Updating agent target");

    try {
      const result = await api.setAgentTarget(target);
      renderAgentTarget(result, { clearCommands: true });
      await queryClient.invalidateQueries({ queryKey: ["agent-target"] });
      await queryClient.invalidateQueries({ queryKey: ["recent-chats"] });
      setMessages(withoutTargetSwitchNotices);
      announceCommand(`Using ${result.label}.`, "Agent target updated");
    } catch (error) {
      addMessage(error instanceof Error ? error.message : "Agent target could not be updated.", "warning");
      setWorkStatus("idle", "Ready", "Agent target unchanged");
    }
  }

  async function renameCurrentThread(title: string) {
    const threadTitle = title.trim();

    if (!threadTitle) {
      addMessage("Rename to what?", "warning");
      setWorkStatus("idle", "Ready", "Missing thread name");
      return;
    }

    setWorkStatus("processing", "Renaming", "Updating thread name");

    try {
      const previousFeedKey = activeFeedKeyRef.current;
      const result = await api.renameThread(threadTitle);

      if (result.target) {
        rekeyFeedMessages(previousFeedKey, feedKeyFromTarget(result.target));
        renderAgentTarget(result.target);
        await queryClient.invalidateQueries({ queryKey: ["agent-target"] });
      }

      await queryClient.invalidateQueries({ queryKey: ["recent-chats"] });
      announceCommand(`Renamed to ${result.chat?.label || threadTitle}.`, "Thread renamed");
    } catch (error) {
      addMessage(error instanceof Error ? error.message : "Thread could not be renamed.", "warning");
      setWorkStatus("idle", "Ready", "Rename failed");
    }
  }

  async function pollAgentEvents() {
    try {
      const result = await api.getAgentEvents(agentEventCursorRef.current);
      agentEventCursorRef.current = result.cursor ?? agentEventCursorRef.current;
      (result.events || []).forEach(handleAgentEvent);

      if (result.events?.length) {
        void queryClient.invalidateQueries({ queryKey: ["recent-chats"] });
      }
    } catch {
      // Polling is opportunistic; health checks keep the visible status honest.
    }
  }

  function handleAgentEvent(event: AgentEvent) {
    const text = String(event.text || "").trim();

    if (!text) {
      return;
    }

    const previousCommandFeedKey = event.commandId ? commandFeedKeysRef.current[event.commandId] : "";
    const eventFeedKey = feedKeyFromAgentEvent(event, commandFeedKeysRef.current);

    if (previousCommandFeedKey && previousCommandFeedKey !== eventFeedKey) {
      rekeyFeedMessages(previousCommandFeedKey, eventFeedKey);
    }

    rememberCommandFeedKey(event.commandId, eventFeedKey);

    if (
      event.target &&
      activeAgentTargetRef.current?.mode === "new" &&
      event.level === "system" &&
      /^(Using |Created Codex chat )/.test(text)
    ) {
      renderAgentTarget(event.target);
    }

    const isWarning = ["warning", "error"].includes(String(event.level || ""));
    const shouldSpeak = event.speak ?? responseAudioRef.current;
    addMessage(text, isWarning ? "warning" : "agent", {
      feedKey: eventFeedKey,
      speak: shouldSpeak,
      target: event.target,
    });
  }

  function promptListKind() {
    activeListContextRef.current = { kind: "choices" };
    announceCommand("Would you like to list projects or chats?", "Choose projects or chats");
  }

  function projectName(project: CatalogProject) {
    return String(project.label || project.workspace || project.id || "Codex project").trim();
  }

  function formatProject(project: CatalogProject, index: number, start: number) {
    return `${start + index + 1}. ${projectName(project)}`;
  }

  function projectTarget(project: CatalogProject): AgentTarget {
    const name = projectName(project);

    return {
      provider: "codex",
      label: `${name} / New chat`,
      workspace: project.workspace || "",
      workspaceQuery: project.workspace ? undefined : name,
      route: name,
      sessionHint: name,
      mode: "new",
    };
  }

  async function listProjects(after = 0) {
    lastListedChatsRef.current = [];
    lastListedProjectsRef.current = [];
    setWorkStatus("processing", "Listing", "Loading Codex projects");

    try {
      const result = await api.fetchCatalog("projects", { after, limit: CATALOG_PAGE_LIMIT });
      const projects = result.projects || [];

      if (!projects.length) {
        activeListContextRef.current = null;
        announceCommand(
          after ? "No more Codex projects found." : "No Codex projects found.",
          after ? "No more projects" : "No projects found",
        );
        return;
      }

      const projectText = projects.map((project, index) => formatProject(project, index, after)).join("\n");
      const cursor = result.cursor || after + projects.length;
      const total = result.total || 0;
      const hasMore = cursor < total;
      activeListContextRef.current = hasMore ? { kind: "projects", cursor } : null;
      lastListedProjectsRef.current = projects.map((project, index) => ({
        project,
        number: after + index + 1,
        position: index + 1,
      }));

      addMessage(`Projects:\n${projectText}${hasMore ? "\nSay continue for more." : ""}`, "system");
      setWorkStatus("idle", "Ready", hasMore ? "Say continue for more" : `${total} projects listed`);
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

  function chatTarget(chat: CatalogChat): AgentTarget {
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

  function listedChatTarget(item: ListedChat): AgentTarget {
    return chatTarget(item.chat);
  }

  function listedProjectTarget(item: ListedProject): AgentTarget {
    return projectTarget(item.project);
  }

  async function useRecentChat(chat: CatalogChat) {
    await setAgentTarget(chatTarget(chat));
  }

  function useUncategorizedFeed() {
    clearTransientCommandState();
    activeFeedKeyRef.current = GLOBAL_FEED_KEY;
    selectedFeedKeyRef.current = GLOBAL_FEED_KEY;
    setSelectedFeedKey(GLOBAL_FEED_KEY);
    setWorkStatus("idle", "Ready", UNCATEGORIZED_THREAD_LABEL);
  }

  async function useListedItem(number: number | null) {
    if (!number) {
      addMessage("Which listed item should I use?", "warning");
      setWorkStatus("idle", "Ready", "Say use one");
      return;
    }

    const projectItem = lastListedProjectsRef.current.find(
      (listed) => listed.number === number || listed.position === number,
    );

    if (projectItem) {
      await setAgentTarget(listedProjectTarget(projectItem));
      return;
    }

    const chatItem = lastListedChatsRef.current.find((listed) => listed.number === number || listed.position === number);

    if (!chatItem) {
      addMessage("That listed item is not on the current page.", "warning");
      setWorkStatus("idle", "Ready", "Listed item not found");
      return;
    }

    await setAgentTarget(listedChatTarget(chatItem));
  }

  async function listChats(after = 0, project = "") {
    const scoped = project.trim();
    const loadingDetail = scoped ? `Loading chats in ${scoped}` : "Loading Codex chats";
    lastListedProjectsRef.current = [];
    setWorkStatus("processing", "Listing", loadingDetail);

    try {
      const result = await api.fetchCatalog("chats", { after, limit: 5, project: scoped });
      const chats = result.chats || [];
      const projectLabel = result.project?.label || scoped;

      if (result.projectMissing) {
        activeListContextRef.current = { kind: "choices" };
        lastListedChatsRef.current = [];
        lastListedProjectsRef.current = [];
        addMessage(`No Codex project matched ${scoped}.`, "warning");
        setWorkStatus("idle", "Ready", "Project not found");
        return;
      }

      if (!chats.length) {
        activeListContextRef.current = null;
        lastListedChatsRef.current = [];
        lastListedProjectsRef.current = [];
        announceCommand(
          projectLabel ? `No Codex chats found in ${projectLabel}.` : "No more Codex chats found.",
          "No more chats",
        );
        return;
      }

      const chatText = chats.map((chat, index) => formatChat(chat, index, after)).join("\n");
      const hasMore = result.cursor < result.total;
      activeListContextRef.current = hasMore ? { kind: "chats", cursor: result.cursor, project: scoped } : null;
      lastListedChatsRef.current = chats.map((chat, index) => ({
        chat,
        number: after + index + 1,
        position: index + 1,
      }));
      const label = projectLabel ? `Chats in ${projectLabel}` : "Chats";
      addMessage(`${label}:\n${chatText}${hasMore ? "\nSay continue for more." : ""}`, "system");
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

    if (context?.kind === "projects") {
      await listProjects(context.cursor);
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

    setDraftText(draftWithDictationText(draftRef.current, text, appendDictationRef.current));

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

      case "useListedItem":
        await useListedItem(action.number);
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

      case "renameThread":
        await renameCurrentThread(action.title);
        return;

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
    stopAppAudio({
      audioStopToken: audioStopTokenRef,
      responseAudioQueue: responseAudioQueueRef,
      activeSpeechFinish: activeSpeechFinishRef,
      activeUtterance: activeUtteranceRef,
      activeAudioSource: activeAudioSourceRef,
      activeAudioElement: activeAudioElementRef,
      activeAudioFinish: activeAudioFinishRef,
      activeAudioUrl: activeAudioUrlRef,
      speechSynthesis: window.speechSynthesis,
      revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    });

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
      let settled = false;
      let started = false;

      const timeout = window.setTimeout(
        () => {
          const speechState = window.speechSynthesis;
          finish(started || speechState?.speaking || speechState?.pending ? true : false);
        },
        Math.max(MIN_BROWSER_TTS_WATCHDOG_MS, Math.min(MAX_BROWSER_TTS_WATCHDOG_MS, text.length * 90)),
      );

      function finish(result: SpeechResult) {
        if (settled) {
          return;
        }

        settled = true;
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
      utterance.addEventListener("start", () => {
        started = true;
        setWorkStatus("speaking", label, detail);
      });
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
      const commandId = result.command?.id || result.message?.id;
      const feedKey = target ? feedKeyFromTarget(target) : activeFeedKeyRef.current;
      const statusText = queued ? "Queued" : "Sent";
      const dispatchStatus = queued ? "queued" : "sent";
      const dispatchLabel = queued ? "Queued for agent" : "Sent to agent";
      rememberCommandFeedKey(commandId, feedKey);
      addMessage(text, "user", { feedKey, dispatchStatus, dispatchLabel, target });
      renderAgentTarget(target);
      void queryClient.invalidateQueries({ queryKey: ["recent-chats"] });
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

  const recentChats = recentChatsQuery.data?.chats || [];
  const workingThreadCount = recentChats.filter((chat) => chat.busy).length;
  const uncategorizedCount = feedMessageCount(messages, GLOBAL_FEED_KEY);
  const uncategorizedActivity = feedActivity[GLOBAL_FEED_KEY] || {};
  const threadItems = [
    ...recentChats.map((chat, index) => {
      const feedKey = feedKeyFromTarget(chatTarget(chat));
      const activity = feedActivity[feedKey] || {};

      return {
        kind: "chat" as const,
        chat,
        feedKey,
        order: threadOrder[feedKey] ?? index,
        sortAt: activity.lastUserAt || Date.parse(chat.lastCommandAt || "") || 0,
      };
    }),
    {
      kind: "uncategorized" as const,
      feedKey: GLOBAL_FEED_KEY,
      messageCount: uncategorizedCount,
      order: Number.MAX_SAFE_INTEGER,
      sortAt: uncategorizedActivity.lastAnyAt || 0,
    },
  ].sort((left, right) => right.sortAt - left.sortAt || left.order - right.order);
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
            <div className="settings-menu" ref={settingsMenuRef}>
              <button
                className={`settings-button icon-button ${settingsMenuOpen ? "is-active" : ""}`}
                type="button"
                aria-label="Settings"
                title="Settings"
                aria-haspopup="true"
                aria-expanded={settingsMenuOpen}
                onClick={() => setSettingsMenuOpen((open) => !open)}
              >
                <Menu aria-hidden="true" />
              </button>

              {settingsMenuOpen ? (
                <div className="settings-panel" aria-label="Settings">
                  <ToggleControl label="Echo" checked={echoEnabled} onChange={handleEchoChange} />
                  <ToggleControl
                    label="Auto Send"
                    checked={autoSendEnabled}
                    onChange={(checked) => {
                      setAutoSendEnabled(checked);
                      setWorkStatus("idle", "Ready", checked ? "Auto Send on" : "Auto Send off");
                    }}
                  />
                  <ToggleControl
                    label="Append"
                    checked={appendDictationEnabled}
                    onChange={(checked) => {
                      setAppendDictationEnabled(checked);
                      setWorkStatus("idle", "Ready", checked ? "Dictation appends" : "Dictation replaces");
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
              ) : null}
            </div>
          </div>
        </header>

        <section className="target-strip" aria-live="polite">
          <span>Agent</span>
          <strong>{agentTargetLabel}</strong>
        </section>

        <section className="thread-strip" aria-label="Recent chats">
          <div className="thread-strip-head">
            <span>Threads</span>
            {workingThreadCount ? (
              <strong>{workingThreadCount} working</strong>
            ) : (
              <span>{recentChatsQuery.isFetching ? "Syncing" : "Recent"}</span>
            )}
          </div>

          <div className="thread-list">
            {threadItems.map((item) => {
              const isActive = activeFeedKey === item.feedKey;

              if (item.kind === "uncategorized") {
                const meta = item.messageCount ? `${item.messageCount} message${item.messageCount === 1 ? "" : "s"}` : "Global feed";

                return (
                  <button
                    className={`thread-button ${isActive ? "is-active" : ""}`}
                    key={item.feedKey}
                    type="button"
                    title={UNCATEGORIZED_THREAD_LABEL}
                    aria-label={`${UNCATEGORIZED_THREAD_LABEL}. ${meta}`}
                    onClick={useUncategorizedFeed}
                  >
                    <span className="thread-dot" aria-hidden="true" />
                    <span className="thread-copy">
                      <span className="thread-title">{UNCATEGORIZED_THREAD_LABEL}</span>
                      <span className="thread-meta">{meta}</span>
                    </span>
                    {item.messageCount ? <span className="thread-badge">{item.messageCount}</span> : null}
                  </button>
                );
              }

              const chat = item.chat;
              const age = formatThreadAge(chat.lastCommandAt || chat.updatedAt);
              const meta = [chat.projectLabel, age].filter(Boolean).join(" - ");
              const title = chat.projectLabel ? `${chat.projectLabel} / ${chat.label}` : chat.label;

              return (
                <button
                  className={`thread-button ${isActive ? "is-active" : ""} ${chat.busy ? "is-busy" : ""}`}
                  key={chat.id}
                  type="button"
                  title={title}
                  aria-label={`${title}. ${chat.busy ? "Agent still working" : "Idle"}`}
                  onClick={() => void useRecentChat(chat)}
                >
                  <span className={`thread-dot ${chat.busy ? "is-busy" : ""}`} aria-hidden="true" />
                  <span className="thread-copy">
                    <span className="thread-title">{chat.label}</span>
                    {meta ? (
                      <span className="thread-meta">
                        {chat.lastCommandAt || chat.updatedAt ? <time dateTime={chat.lastCommandAt || chat.updatedAt}>{meta}</time> : meta}
                      </span>
                    ) : null}
                  </span>
                  {chat.busy ? (
                    <span className="thread-badge">
                      <LoaderCircle aria-hidden="true" />
                      <span>Working</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className="feed" aria-label="Session" ref={feedRef}>
          {visibleMessages.map((message) => (
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
