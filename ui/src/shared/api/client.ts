import type {
  AgentCommandResponse,
  AgentEventsResponse,
  AgentTarget,
  CatalogChatResponse,
  CatalogProjectResponse,
  HealthStatus,
  RenameThreadResponse,
  SessionStatus,
  ScreenshotMeta,
} from "../types";

export const apiRoutes = {
  sessionStatus: "/api/session/status",
  sessionUnlock: "/api/session/unlock",
  transcribe: "/api/speech/transcribe",
  synthesize: "/api/speech/synthesize",
  sendCommand: "/api/agent/commands",
  screenshot: "/api/screenshot/active-window",
  target: "/api/agent/target",
  renameThread: "/api/agent/thread/rename",
  events: "/api/agent/events",
  catalog: "/api/agent/catalog",
  health: "/api/health",
} as const;

export interface ApiClient {
  fetch(url: string, options?: RequestInit): Promise<Response>;
  sessionStatus(): Promise<SessionStatus>;
  unlockSession(body: unknown): Promise<Response>;
  health(): Promise<{ response: Response; body: HealthStatus }>;
  getAgentTarget(): Promise<AgentTarget | null>;
  setAgentTarget(target: AgentTarget): Promise<AgentTarget>;
  getAgentEvents(after: number | "latest", limit?: number): Promise<AgentEventsResponse>;
  fetchCatalog(kind: "projects", options?: CatalogOptions): Promise<CatalogProjectResponse>;
  fetchCatalog(kind: "chats", options?: CatalogOptions): Promise<CatalogChatResponse>;
  requestScreenshot(): Promise<{ blob: Blob; meta: ScreenshotMeta }>;
  transcribe(audio: Blob, metadata: { durationMs: number; mimeType?: string }): Promise<{ text: string; blank: boolean }>;
  synthesize(text: string): Promise<ArrayBuffer | null>;
  sendCommand(body: { text: string; input: string; source: string; echo: boolean }): Promise<AgentCommandResponse>;
  renameThread(title: string): Promise<RenameThreadResponse>;
}

export interface CatalogOptions {
  after?: number;
  limit?: number;
  project?: string;
}

export function createApiClient(getAccessToken: () => string): ApiClient {
  async function apiFetch(url: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers || {});
    const accessToken = getAccessToken();

    if (accessToken) {
      headers.set("X-WITS-Token", accessToken);
    }

    return fetch(url, {
      ...options,
      headers,
    });
  }

  async function readJson<T>(response: Response): Promise<T> {
    return response.json() as Promise<T>;
  }

  return {
    fetch: apiFetch,

    async sessionStatus() {
      const response = await apiFetch(apiRoutes.sessionStatus);

      if (!response.ok) {
        return {
          pinRequired: false,
          authenticated: false,
        };
      }

      return readJson<SessionStatus>(response);
    },

    unlockSession(body) {
      return fetch(apiRoutes.sessionUnlock, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },

    async health() {
      const response = await apiFetch(apiRoutes.health);
      const body = (await response.json().catch(() => ({}))) as HealthStatus;
      return { response, body };
    },

    async getAgentTarget() {
      const response = await apiFetch(apiRoutes.target);

      if (!response.ok) {
        return null;
      }

      const result = await readJson<{ target?: AgentTarget }>(response);
      return result.target || null;
    },

    async setAgentTarget(target) {
      const response = await apiFetch(apiRoutes.target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target),
      });

      if (!response.ok) {
        throw new Error("Agent target could not be updated.");
      }

      const result = await readJson<{ target: AgentTarget }>(response);
      return result.target;
    },

    async renameThread(title) {
      const response = await apiFetch(apiRoutes.renameThread, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });

      if (!response.ok) {
        throw await responseError(response, "Thread could not be renamed.");
      }

      return readJson<RenameThreadResponse>(response);
    },

    async getAgentEvents(after, limit) {
      const params = new URLSearchParams({ after: String(after) });

      if (limit !== undefined) {
        params.set("limit", String(limit));
      }

      const response = await apiFetch(`${apiRoutes.events}?${params}`);

      if (!response.ok) {
        return {};
      }

      return readJson<AgentEventsResponse>(response);
    },

    async fetchCatalog(kind, options = {}) {
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
      const response = await apiFetch(`${apiRoutes.catalog}/${kind}${suffix}`);

      if (!response.ok) {
        throw new Error("Could not load the Codex list.");
      }

      return response.json();
    },

    async requestScreenshot() {
      const response = await apiFetch(apiRoutes.screenshot, { method: "POST" });

      if (!response.ok) {
        throw await responseError(response, "Screenshot capture failed.");
      }

      return {
        blob: await response.blob(),
        meta: parseScreenshotMeta(response),
      };
    },

    async transcribe(audio, metadata) {
      const response = await apiFetch(apiRoutes.transcribe, {
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

      const result = await readJson<{ text?: string; blank?: boolean }>(response);
      return {
        text: result.text || "",
        blank: Boolean(result.blank),
      };
    },

    async synthesize(text) {
      const response = await apiFetch(apiRoutes.synthesize, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        return null;
      }

      return response.arrayBuffer();
    },

    async sendCommand(body) {
      const response = await apiFetch(apiRoutes.sendCommand, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error("Desktop command route is not connected.");
      }

      return readJson<AgentCommandResponse>(response);
    },
  };
}

export function parseScreenshotMeta(response: Response): ScreenshotMeta {
  const encoded = response.headers.get("X-WITS-Screenshot-Meta");

  if (!encoded) {
    return {};
  }

  try {
    return JSON.parse(decodeURIComponent(encoded)) as ScreenshotMeta;
  } catch {
    return {};
  }
}

export async function responseError(response: Response, fallback: string) {
  try {
    const result = (await response.json()) as { error?: string };
    return new Error(result.error || fallback);
  } catch {
    return new Error(fallback);
  }
}
