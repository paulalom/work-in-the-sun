export type CaptureMode = "dictation" | "command";

export type WorkState = "idle" | "listening" | "processing" | "speaking";

export type FeedMessageType = "agent" | "system" | "user" | "warning";

export type DispatchStatus = "queued" | "sent";

export interface FeedMessage {
  id: string;
  type: FeedMessageType;
  text: string;
  dispatchStatus?: DispatchStatus;
  dispatchLabel?: string;
  screenshotUrl?: string;
  screenshotMeta?: ScreenshotMeta;
}

export interface WorkStatus {
  state: WorkState;
  label: string;
  detail: string;
  mode: CaptureMode;
}

export interface AgentTarget {
  id?: string;
  provider?: string;
  label?: string;
  workspace?: string;
  workspaceQuery?: string;
  sessionHint?: string;
  mode?: "existing" | "new";
  deliveryMode?: "windows-ui" | "app-server-stdio";
  route?: string;
}

export interface ServerIdentity {
  version?: string;
  host?: string;
}

export interface PinUnlock {
  encrypted: boolean;
  algorithm: string;
  publicKey: string;
  fingerprint: string;
  maxPinChars?: number;
}

export interface SessionStatus {
  identity?: ServerIdentity;
  pinRequired: boolean;
  authenticated: boolean;
  pinUnlock?: PinUnlock | null;
}

export interface HealthStatus {
  speech?: {
    available?: boolean;
    missing?: string[];
    ffmpeg?: {
      available?: boolean;
    };
  };
  tts?: {
    available?: boolean;
    engine?: string | null;
  };
  agent?: {
    activeTarget?: AgentTarget | null;
    codexDirect?: unknown;
  };
}

export interface AgentEvent {
  text?: string;
  level?: "progress" | "result" | "system" | "warning" | "error";
  speak?: boolean;
}

export interface AgentEventsResponse {
  cursor?: number;
  total?: number;
  events?: AgentEvent[];
}

export interface AgentCommandResponse {
  command?: {
    id?: string;
    status?: string;
    target?: AgentTarget;
  };
  message?: {
    id?: string;
    status?: string;
    target?: AgentTarget;
  };
}

export interface ScreenshotMeta {
  capturedAt?: string;
  windowTitle?: string;
  chatTitle?: string;
  processName?: string;
  width?: number;
  height?: number;
  target?: AgentTarget;
}

export interface CatalogProject {
  id?: string;
  label?: string;
  workspace?: string;
}

export interface CatalogChat {
  id: string;
  label: string;
  projectLabel?: string;
  workspace?: string;
}

export interface CatalogProjectResponse {
  provider?: string;
  kind?: "projects";
  cursor?: number;
  total?: number;
  projects?: CatalogProject[];
}

export interface CatalogChatResponse {
  provider?: string;
  kind?: "chats";
  cursor: number;
  total: number;
  project?: CatalogProject;
  projectMissing?: boolean;
  chats?: CatalogChat[];
}

export interface ListedChat {
  chat: CatalogChat;
  number: number;
  position: number;
}

export type ListContext =
  | {
      kind: "choices";
    }
  | {
      kind: "chats";
      cursor: number;
      project?: string;
    }
  | null;
