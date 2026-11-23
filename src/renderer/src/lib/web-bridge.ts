import type { OpenDexApi, ChatRequest, ChatHandle } from "../../../preload/api-types";
import type {
  ChatMessage,
  PermissionRequestPayload,
  RealtimeClientMessage,
  RealtimeServerNotice,
  RealtimeStartResult,
  SessionState,
  ToolCallEvent,
  ToolResultEvent,
  UpdateStatusPayload,
  ViewCommand,
  WindowMode,
} from "../../../main/ipc/channels";
import type { PermissionDecision } from "../../../main/agent/permissions";
import type {
  DeepPartial,
  OpenDexConfig,
  PublicConfig,
  SecretName,
  SttProvider,
} from "../../../main/config/schema";

const CLIENT_ID = crypto.randomUUID();

// ── Lightweight pub/sub for browser shell state (Settings modal, Notch mode,
//    Overlay HUD) that used to live across separate Electron BrowserWindows.
type Listener<T> = (val: T) => void;

function createEmitter<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    on(fn: Listener<T>): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(val: T) {
      for (const fn of listeners) fn(val);
    },
  };
}

const configEmitter = createEmitter<PublicConfig>();
const permissionReqEmitter = createEmitter<PermissionRequestPayload>();
const permissionDismissEmitter = createEmitter<string>();
const pushToTalkEmitter = createEmitter<void>();
const interruptEmitter = createEmitter<void>();
const sessionStateEmitter = createEmitter<SessionState>();
const windowModeEmitter = createEmitter<WindowMode>();
const remoteCommandEmitter = createEmitter<ViewCommand>();
const summonedEmitter = createEmitter<void>();
const updateStatusEmitter = createEmitter<UpdateStatusPayload>();
const settingsOpenEmitter = createEmitter<boolean>();
const notchSizeEmitter = createEmitter<{ width: number; height: number }>();

let latestSessionState: SessionState | null = null;
let currentWindowMode: WindowMode = "full";
let currentNotchSize = { width: 320, height: 44 };
let settingsOpen = false;

export const webShellStore = {
  getSettingsOpen: () => settingsOpen,
  setSettingsOpen: (open: boolean) => {
    settingsOpen = open;
    settingsOpenEmitter.emit(open);
  },
  onSettingsOpen: (fn: (open: boolean) => void) => settingsOpenEmitter.on(fn),
  getWindowMode: () => currentWindowMode,
  getNotchSize: () => currentNotchSize,
  onNotchSize: (fn: (size: { width: number; height: number }) => void) =>
    notchSizeEmitter.on(fn),
  getLatestSessionState: () => latestSessionState,
};

// ── SSE connection to server for config sync & permission prompts ────────────
let eventSource: EventSource | null = null;

function ensureEventSource() {
  if (typeof window === "undefined" || eventSource) return;
  eventSource = new EventSource(`/api/events?clientId=${encodeURIComponent(CLIENT_ID)}`);
  eventSource.addEventListener("config:changed", (e) => {
    try {
      configEmitter.emit(JSON.parse((e as MessageEvent).data) as PublicConfig);
    } catch {
      // ignore
    }
  });
  eventSource.addEventListener("permission:request", (e) => {
    try {
      permissionReqEmitter.emit(
        JSON.parse((e as MessageEvent).data) as PermissionRequestPayload,
      );
    } catch {
      // ignore
    }
  });
  eventSource.addEventListener("permission:dismiss", (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as { id: string };
      permissionDismissEmitter.emit(data.id);
    } catch {
      // ignore
    }
  });
}

if (typeof window !== "undefined") {
  ensureEventSource();

  // In-browser keyboard shortcuts replacing Electron globalShortcut:
  //   Ctrl/Cmd + Shift + Space → push to talk
  //   Ctrl/Cmd + Escape        → interrupt / emergency stop
  //   Alt + Space              → summon / focus input
  window.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && e.code === "Space") {
      e.preventDefault();
      pushToTalkEmitter.emit();
    } else if (mod && e.key === "Escape") {
      e.preventDefault();
      interruptEmitter.emit();
    } else if (e.altKey && e.code === "Space") {
      e.preventDefault();
      summonedEmitter.emit();
    }
  });
}

// ── Realtime WebSocket management ───────────────────────────────────────────
interface ActiveRealtime {
  ws: WebSocket;
  emitter: ReturnType<typeof createEmitter<RealtimeServerNotice>>;
}

const activeRealtimes = new Map<string, ActiveRealtime>();

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-client-id": CLIENT_ID,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || res.statusText);
  }
  return (await res.json()) as T;
}

const opendex: OpenDexApi = {
  platform: "web",

  chat({ messages, mode, onDelta, onToolCall, onToolResult }: ChatRequest): ChatHandle {
    const requestId = crypto.randomUUID();
    const ac = new AbortController();

    const done = (async (): Promise<ChatMessage[]> => {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          "x-client-id": CLIENT_ID,
        },
        body: JSON.stringify({ requestId, messages, mode }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Chat request failed: ${res.status} ${res.statusText}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalMessages: ChatMessage[] = [];

      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const evt = JSON.parse(trimmed) as
            | { type: "delta"; text: string }
            | { type: "tool"; call: ToolCallEvent }
            | { type: "tool-result"; result: ToolResultEvent }
            | { type: "done"; messages: ChatMessage[] }
            | { type: "error"; message: string };
          if (evt.type === "delta") onDelta(evt.text);
          else if (evt.type === "tool") onToolCall?.(evt.call);
          else if (evt.type === "tool-result") onToolResult?.(evt.result);
          else if (evt.type === "done") finalMessages = evt.messages;
          else if (evt.type === "error") throw new Error(evt.message);
        }
      }
      return finalMessages;
    })().catch((err) => {
      if ((err as Error)?.name === "AbortError") return [];
      throw err;
    });

    return {
      cancel: () => {
        ac.abort();
        void fetch("/api/chat/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId }),
        }).catch(() => {});
      },
      done,
    };
  },

  async synthesize(text: string): Promise<ArrayBuffer> {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((body as { error?: string }).error || "TTS failed");
    }
    return res.arrayBuffer();
  },

  async realtimeStart(opts: { briefing: boolean }): Promise<RealtimeStartResult> {
    const start = await apiJson<RealtimeStartResult>("/api/realtime/start", {
      method: "POST",
      body: JSON.stringify(opts),
    });

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/api/realtime?sessionId=${encodeURIComponent(start.sessionId)}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    const emitter = createEmitter<RealtimeServerNotice>();
    activeRealtimes.set(start.sessionId, { ws, emitter });

    ws.addEventListener("message", (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        emitter.emit({ type: "audio", chunk: ev.data });
      } else if (typeof ev.data === "string") {
        try {
          emitter.emit(JSON.parse(ev.data) as RealtimeServerNotice);
        } catch {
          // ignore
        }
      }
    });

    ws.addEventListener("close", () => {
      activeRealtimes.delete(start.sessionId);
    });

    return start;
  },

  realtimeSend(sessionId: string, msg: RealtimeClientMessage): void {
    const entry = activeRealtimes.get(sessionId);
    if (!entry) return;
    const sendNow = () => {
      if (msg.type === "audio") {
        entry.ws.send(msg.chunk);
      } else {
        entry.ws.send(JSON.stringify(msg));
      }
    };
    if (entry.ws.readyState === WebSocket.OPEN) {
      sendNow();
    } else if (entry.ws.readyState === WebSocket.CONNECTING) {
      entry.ws.addEventListener("open", sendNow, { once: true });
    }
  },

  onRealtimeEvent(
    sessionId: string,
    handler: (notice: RealtimeServerNotice) => void,
  ): () => void {
    const entry = activeRealtimes.get(sessionId);
    if (!entry) return () => {};
    return entry.emitter.on(handler);
  },

  realtimeEnd(sessionId: string): void {
    const entry = activeRealtimes.get(sessionId);
    if (entry) {
      activeRealtimes.delete(sessionId);
      try {
        entry.ws.close();
      } catch {
        // ignore
      }
    }
    void fetch("/api/realtime/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  },

  getConfig(): Promise<PublicConfig> {
    return apiJson<PublicConfig>("/api/config");
  },

  setConfig(patch: DeepPartial<OpenDexConfig>): Promise<PublicConfig> {
    return apiJson<PublicConfig>("/api/config", {
      method: "POST",
      body: JSON.stringify(patch),
    });
  },

  setSecret(name: SecretName, value: string): Promise<PublicConfig> {
    return apiJson<PublicConfig>("/api/secret", {
      method: "POST",
      body: JSON.stringify({ name, value }),
    });
  },

  completeOnboarding(): Promise<PublicConfig> {
    return apiJson<PublicConfig>("/api/onboarding/complete", {
      method: "POST",
    });
  },

  resetConfig(): Promise<PublicConfig> {
    return apiJson<PublicConfig>("/api/config/reset", {
      method: "POST",
    });
  },

  async openSettings(): Promise<void> {
    webShellStore.setSettingsOpen(true);
  },

  onConfigChanged(handler: (config: PublicConfig) => void): () => void {
    return configEmitter.on(handler);
  },

  async transcribe(provider: SttProvider, wav: ArrayBuffer): Promise<string> {
    const res = await fetch(`/api/stt?provider=${encodeURIComponent(provider)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: wav,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((body as { error?: string }).error || "Transcription failed");
    }
    const data = (await res.json()) as { text: string };
    return data.text;
  },

  appleAvailability(): Promise<{ available: boolean; reason?: string }> {
    return apiJson<{ available: boolean; reason?: string }>(
      "/api/llm/apple-availability",
    );
  },

  onPushToTalk(handler: () => void): () => void {
    return pushToTalkEmitter.on(handler);
  },

  onInterrupt(handler: () => void): () => void {
    return interruptEmitter.on(handler);
  },

  publishSessionState(state: SessionState): void {
    latestSessionState = state;
    sessionStateEmitter.emit(state);
  },

  onSessionState(handler: (state: SessionState) => void): () => void {
    if (latestSessionState) handler(latestSessionState);
    return sessionStateEmitter.on(handler);
  },

  setWindowMode(mode: WindowMode): void {
    currentWindowMode = mode;
    windowModeEmitter.emit(mode);
  },

  setNotchSize(width: number, height: number): void {
    currentNotchSize = { width, height };
    notchSizeEmitter.emit(currentNotchSize);
  },

  focusNotch(): void {
    // No-op in single-window web runtime
  },

  onWindowMode(handler: (mode: WindowMode) => void): () => void {
    return windowModeEmitter.on(handler);
  },

  sendViewCommand(cmd: ViewCommand): void {
    if (cmd.type === "expand") {
      opendex.setWindowMode("full");
    } else {
      remoteCommandEmitter.emit(cmd);
    }
  },

  onRemoteCommand(handler: (cmd: ViewCommand) => void): () => void {
    return remoteCommandEmitter.on(handler);
  },

  onSummoned(handler: () => void): () => void {
    return summonedEmitter.on(handler);
  },

  setOverlayInteractive(_interactive: boolean): void {
    // No-op in single-window web runtime
  },

  overlayInterrupt(): void {
    interruptEmitter.emit();
  },

  onPermissionRequest(
    handler: (req: PermissionRequestPayload) => void,
  ): () => void {
    return permissionReqEmitter.on(handler);
  },

  onPermissionDismiss(handler: (id: string) => void): () => void {
    return permissionDismissEmitter.on(handler);
  },

  onUpdateStatus(handler: (status: UpdateStatusPayload) => void): () => void {
    return updateStatusEmitter.on(handler);
  },

  respondPermission(
    id: string,
    skillId: string,
    decision: PermissionDecision,
  ): void {
    void apiJson("/api/permission/respond", {
      method: "POST",
      body: JSON.stringify({ id, skillId, decision }),
    }).catch(() => {});
  },
};

if (typeof window !== "undefined" && !window.opendex) {
  window.opendex = opendex;
}
