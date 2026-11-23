import type {
  ChatMessage,
  RealtimeClientMessage,
  RealtimeServerNotice,
  RealtimeStartResult,
  SessionState,
  ToolCallEvent,
  ToolResultEvent,
  UpdateStatusPayload,
  ViewCommand,
  WindowMode,
  PermissionRequestPayload,
} from "../main/ipc/channels";
import type { PermissionDecision } from "../main/agent/permissions";
import type {
  DeepPartial,
  OpenDexConfig,
  PublicConfig,
  SecretName,
  SttProvider,
} from "../main/config/schema";

export interface ChatRequest {
  messages: ChatMessage[];
  mode?: "briefing";
  onDelta: (text: string) => void;
  onToolCall?: (call: ToolCallEvent) => void;
  onToolResult?: (result: ToolResultEvent) => void;
}

export interface ChatHandle {
  cancel: () => void;
  done: Promise<ChatMessage[]>;
}

export interface OpenDexApi {
  platform: NodeJS.Platform | "web";
  chat(req: ChatRequest): ChatHandle;
  synthesize(text: string): Promise<ArrayBuffer>;
  realtimeStart(opts: { briefing: boolean }): Promise<RealtimeStartResult>;
  realtimeSend(sessionId: string, msg: RealtimeClientMessage): void;
  onRealtimeEvent(
    sessionId: string,
    handler: (notice: RealtimeServerNotice) => void,
  ): () => void;
  realtimeEnd(sessionId: string): void;
  getConfig(): Promise<PublicConfig>;
  setConfig(patch: DeepPartial<OpenDexConfig>): Promise<PublicConfig>;
  setSecret(name: SecretName, value: string): Promise<PublicConfig>;
  completeOnboarding(): Promise<PublicConfig>;
  resetConfig(): Promise<PublicConfig>;
  openSettings(): Promise<void>;
  onConfigChanged(handler: (config: PublicConfig) => void): () => void;
  transcribe(provider: SttProvider, wav: ArrayBuffer): Promise<string>;
  appleAvailability(): Promise<{ available: boolean; reason?: string }>;
  onPushToTalk(handler: () => void): () => void;
  onInterrupt(handler: () => void): () => void;
  publishSessionState(state: SessionState): void;
  onSessionState(handler: (state: SessionState) => void): () => void;
  setWindowMode(mode: WindowMode): void;
  setNotchSize(width: number, height: number): void;
  focusNotch(): void;
  onWindowMode(handler: (mode: WindowMode) => void): () => void;
  sendViewCommand(cmd: ViewCommand): void;
  onRemoteCommand(handler: (cmd: ViewCommand) => void): () => void;
  onSummoned(handler: () => void): () => void;
  setOverlayInteractive(interactive: boolean): void;
  overlayInterrupt(): void;
  onPermissionRequest(
    handler: (req: PermissionRequestPayload) => void,
  ): () => void;
  onPermissionDismiss(handler: (id: string) => void): () => void;
  onUpdateStatus(handler: (status: UpdateStatusPayload) => void): () => void;
  respondPermission(
    id: string,
    skillId: string,
    decision: PermissionDecision,
  ): void;
}
