export type JsonRecord = Record<string, any>;

export type TargetMode = "existing" | "new";
export type TargetDeliveryMode = "windows-ui" | "app-server-stdio";
export type EventLevel = "progress" | "result" | "system" | "warning" | "error";

export type AgentTarget = {
  id: string;
  provider: string;
  label: string;
  workspace: string;
  sessionHint: string;
  mode: TargetMode;
  deliveryMode?: TargetDeliveryMode;
  route: string;
  threadId?: string;
};

export type AgentCommand = JsonRecord & {
  id?: string;
  text?: string;
  userText?: string;
  target?: Partial<AgentTarget>;
  receivedAt?: string;
};

export type AgentEvent = JsonRecord & {
  id?: string;
  text?: string;
  level?: EventLevel;
  commandId?: string;
  targetId?: string;
  receivedAt?: string;
  speak?: boolean;
  source?: string;
};

export type PageOptions = {
  after?: number | string | null;
  limit?: number | string | null;
};

export type ScreenshotResult = {
  ok?: boolean;
  error?: string;
  imageBase64: string;
  windowTitle?: string;
  chatTitle?: string;
  processName?: string;
  width?: number;
  height?: number;
};
