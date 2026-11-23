import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import {
  initConfig,
  getConfig,
  getPublicConfig,
  updateConfig,
  setSecret,
  completeOnboarding,
  resetConfig,
} from "./src/main/config/store";
import { initAnalytics, track } from "./src/main/analytics";
import { streamChat, type ChatMessage } from "./src/main/agent/chat";
import { resolveModel, checkAppleAvailability } from "./src/main/agent/llm/resolve-model";
import { buildRealtimeInstructions, buildSystemPrompt } from "./src/main/agent/system-prompt";
import {
  makePermissionRequester,
  recordAndResolve,
  setPermissionUi,
  type PermissionDecision,
} from "./src/main/agent/permissions";
import {
  endRealtimeSession,
  sendRealtimeClientMessage,
  startRealtimeSession,
} from "./src/main/agent/realtime/session-host";
import { buildRealtimeToolDefs, directRealtimeSkills } from "./src/main/agent/realtime/realtime-tools";
import { getRealtimeModelMeta } from "./src/main/config/realtime-models";
import { synthesizeSpeech } from "./src/main/tts/elevenlabs";
import { transcribe } from "./src/main/stt";
import { buildToolSet, skillSystemPrompts } from "./src/skills/registry";
import type { DeepPartial, OpenDexConfig, SecretName, SttProvider } from "./src/main/config/schema";
import type {
  PermissionRequestPayload,
  RealtimeClientMessage,
  RealtimeServerNotice,
} from "./src/main/ipc/channels";

initConfig();
initAnalytics();
track("app_started");

const app = express();
const httpServer = createServer(app);

// ── SSE event stream (config sync + permission prompts) ─────────────────────
const sseClients = new Map<string, Set<express.Response>>();

function sendSse(res: express.Response, event: string, data: unknown) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastSse(event: string, data: unknown) {
  for (const set of sseClients.values()) {
    for (const res of set) sendSse(res, event, data);
  }
}

function sendToClientOrAll(clientId: string | undefined, event: string, data: unknown) {
  const targets = clientId ? sseClients.get(clientId) : undefined;
  if (targets && targets.size > 0) {
    for (const res of targets) sendSse(res, event, data);
  } else {
    broadcastSse(event, data);
  }
}

function broadcastConfig() {
  broadcastSse("config:changed", getPublicConfig());
}

// Track which client originated each permission prompt so we can route/dismiss cleanly.
const pendingPermissionClient = new Map<string, string | undefined>();
let currentPromptClientId: string | undefined;

setPermissionUi({
  present: (req: PermissionRequestPayload) => {
    pendingPermissionClient.set(req.id, currentPromptClientId);
    sendToClientOrAll(currentPromptClientId, "permission:request", req);
  },
  dismiss: (id: string) => {
    const cid = pendingPermissionClient.get(id);
    pendingPermissionClient.delete(id);
    sendToClientOrAll(cid, "permission:dismiss", { id });
  },
});

app.get("/api/events", (req, res) => {
  const clientId = String(req.query.clientId || "default");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": connected\n\n");

  let set = sseClients.get(clientId);
  if (!set) {
    set = new Set();
    sseClients.set(clientId, set);
  }
  set.add(res);

  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 20_000);

  res.on("close", () => {
    clearInterval(keepalive);
    set?.delete(res);
    if (set && set.size === 0) sseClients.delete(clientId);
  });
});

// JSON body parser for standard API routes (placed after raw route or scoped)
const jsonParser = express.json({ limit: "10mb" });

// ── Config & Secrets API ────────────────────────────────────────────────────
app.get("/api/config", (_req, res) => {
  res.json(getPublicConfig());
});

app.post("/api/config", jsonParser, (req, res) => {
  const patch = req.body as DeepPartial<OpenDexConfig>;
  const result = updateConfig(patch);
  broadcastConfig();
  res.json(result);
});

app.post("/api/secret", jsonParser, (req, res) => {
  const { name, value } = req.body as { name: SecretName; value: string };
  const result = setSecret(name, value ?? "");
  broadcastConfig();
  res.json(result);
});

app.post("/api/config/reset", (_req, res) => {
  const result = resetConfig();
  broadcastConfig();
  track("config_reset");
  res.json(result);
});

app.post("/api/onboarding/complete", (_req, res) => {
  const result = completeOnboarding();
  broadcastConfig();
  res.json(result);
});

app.get("/api/llm/apple-availability", async (_req, res) => {
  res.json(await checkAppleAvailability());
});

// ── Permissions API ─────────────────────────────────────────────────────────
app.post("/api/permission/respond", jsonParser, (req, res) => {
  const { id, skillId, decision } = req.body as {
    id: string;
    skillId: string;
    decision: PermissionDecision;
  };
  recordAndResolve(id, skillId, decision);
  res.json({ ok: true });
});

// ── Chat Streaming API (NDJSON) ─────────────────────────────────────────────
const inFlightChats = new Map<string, AbortController>();

function stripImageOutput(output: unknown): unknown {
  if (
    output &&
    typeof output === "object" &&
    (output as { type?: string }).type === "content" &&
    Array.isArray((output as { value?: unknown[] }).value) &&
    (output as { value: Array<{ type?: string }> }).value.some(
      (c) => c.type === "media" || c.type === "file-data",
    )
  ) {
    return { type: "content", value: [{ type: "text", value: "[screenshot]" }] };
  }
  return output;
}

app.post("/api/chat", jsonParser, async (req, res) => {
  const { requestId, messages, mode } = req.body as {
    requestId: string;
    messages: ChatMessage[];
    mode?: "briefing";
  };
  const clientId = req.header("x-client-id") || undefined;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const writeEvent = (payload: unknown) => {
    if (!res.writableEnded) {
      res.write(JSON.stringify(payload) + "\n");
    }
  };

  const ac = new AbortController();
  inFlightChats.set(requestId, ac);

  let destroyed = false;
  const destroyListeners = new Set<() => void>();
  res.on("close", () => {
    if (!res.writableEnded) {
      destroyed = true;
      ac.abort();
      for (const cb of destroyListeners) cb();
      destroyListeners.clear();
    }
  });

  const config = getConfig();
  const briefing = mode === "briefing";
  track("command_run", { mode: briefing ? "briefing" : "command" });

  const system = buildSystemPrompt({
    config,
    briefing,
    skillPrompts: briefing ? [] : skillSystemPrompts(config),
  });

  const baseRequester = makePermissionRequester({
    isDestroyed: () => destroyed,
    onDestroyed: (cb) => {
      destroyListeners.add(cb);
      return () => destroyListeners.delete(cb);
    },
  });

  const tools = buildToolSet({
    config,
    requestPermission: async (skillId, label, detail) => {
      currentPromptClientId = clientId;
      return baseRequester(skillId, label, detail);
    },
  });

  try {
    const model = await resolveModel(config);
    const responseMessages = await streamChat({
      messages,
      system,
      model,
      tools,
      briefing,
      signal: ac.signal,
      onDelta: (delta) => {
        if (!ac.signal.aborted) writeEvent({ type: "delta", text: delta });
      },
      onToolCall: (call) => {
        track("tool_used", { tool_name: call.toolName });
        if (!ac.signal.aborted) writeEvent({ type: "tool", call });
      },
      onToolResult: (result) => {
        if (!ac.signal.aborted) {
          writeEvent({
            type: "tool-result",
            result: { ...result, output: stripImageOutput(result.output) },
          });
        }
      },
    });
    writeEvent({ type: "done", messages: responseMessages });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeEvent({ type: "error", message });
  } finally {
    inFlightChats.delete(requestId);
    if (!res.writableEnded) res.end();
  }
});

app.post("/api/chat/cancel", jsonParser, (req, res) => {
  const { requestId } = req.body as { requestId: string };
  inFlightChats.get(requestId)?.abort();
  inFlightChats.delete(requestId);
  res.json({ ok: true });
});

// ── TTS & STT APIs ──────────────────────────────────────────────────────────
app.post("/api/tts", jsonParser, async (req, res) => {
  try {
    const { text } = req.body as { text: string };
    const buffer = await synthesizeSpeech(text);
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post(
  "/api/stt",
  express.raw({ type: "*/*", limit: "25mb" }),
  async (req, res) => {
    try {
      const provider = (req.query.provider as SttProvider) || "openai";
      const wav = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
      const text = await transcribe(provider, wav);
      res.json({ text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  },
);

// ── Realtime Voice Sessions (WebSocket bridge) ──────────────────────────────
const realtimeSockets = new Map<string, WebSocket>();
const realtimeBuffers = new Map<string, RealtimeServerNotice[]>();

function dispatchRealtimeNotice(sessionId: string, notice: RealtimeServerNotice) {
  const ws = realtimeSockets.get(sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (notice.type === "audio") {
      ws.send(Buffer.from(notice.chunk));
    } else {
      ws.send(JSON.stringify(notice));
    }
  } else {
    let buf = realtimeBuffers.get(sessionId);
    if (!buf) {
      buf = [];
      realtimeBuffers.set(sessionId, buf);
    }
    buf.push(notice);
  }
}

app.post("/api/realtime/start", jsonParser, async (req, res) => {
  try {
    const config = getConfig();
    if (config.voice.mode !== "realtime") {
      res.status(400).json({ error: "Realtime voice is not enabled in Settings." });
      return;
    }
    const briefing = Boolean((req.body as { briefing?: boolean })?.briefing);
    const clientId = req.header("x-client-id") || undefined;
    const modelMeta = getRealtimeModelMeta(config.realtime.model);
    track("realtime_session", { model: config.realtime.model });

    const skillPrompts = directRealtimeSkills(config)
      .map((s) => s.systemPrompt)
      .filter((p): p is string => Boolean(p));
    const directIds = new Set(directRealtimeSkills(config).map((s) => s.id));

    let sessionAlive = true;
    const baseRequester = makePermissionRequester({
      isDestroyed: () => !sessionAlive,
    });
    const tools = buildToolSet({
      config,
      requestPermission: async (skillId, label, detail) => {
        currentPromptClientId = clientId;
        return baseRequester(skillId, label, detail);
      },
      include: (skill) => directIds.has(skill.id),
    });

    const sessionId = randomUUID();
    await startRealtimeSession({
      sessionId,
      model: config.realtime.model,
      voice: config.realtime.voice,
      instructions: buildRealtimeInstructions({ config, briefing, skillPrompts }),
      toolDefs: buildRealtimeToolDefs(config),
      tools,
      transcribesInput: modelMeta?.transcribes ?? true,
      notify: (notice) => {
        if (notice.type === "tool-call") {
          track("tool_used", { tool_name: notice.call.toolName });
        }
        if (notice.type === "closed") {
          sessionAlive = false;
        }
        dispatchRealtimeNotice(sessionId, notice);
      },
    });

    res.json({
      sessionId,
      greetingPrompt: briefing ? "Give me my briefing." : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

app.post("/api/realtime/end", jsonParser, (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  if (sessionId) endRealtimeSession(sessionId);
  res.json({ ok: true });
});

const wss = new WebSocketServer({ server: httpServer, path: "/api/realtime" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "", "http://localhost");
  const sessionId = url.searchParams.get("sessionId") || "";
  if (!sessionId) {
    ws.close();
    return;
  }
  realtimeSockets.set(sessionId, ws);

  // Flush any notices buffered between POST /api/realtime/start and WS upgrade
  const buffered = realtimeBuffers.get(sessionId);
  if (buffered) {
    realtimeBuffers.delete(sessionId);
    for (const notice of buffered) {
      dispatchRealtimeNotice(sessionId, notice);
    }
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      sendRealtimeClientMessage(sessionId, { type: "audio", chunk: ab });
    } else {
      try {
        const msg = JSON.parse(String(data)) as RealtimeClientMessage;
        sendRealtimeClientMessage(sessionId, msg);
      } catch {
        // ignore malformed frame
      }
    }
  });

  ws.on("close", () => {
    if (realtimeSockets.get(sessionId) === ws) {
      realtimeSockets.delete(sessionId);
    }
    realtimeBuffers.delete(sessionId);
    endRealtimeSession(sessionId);
  });
});

// ── Frontend Serving (Vite dev middleware or built dist/) ───────────────────
async function setupFrontend() {
  const isProd = process.env.NODE_ENV === "production";
  const distDir = resolve(process.cwd(), "dist");

  if (!isProd || !existsSync(distDir)) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(join(distDir, "index.html"));
    });
  }
}

const PORT = 3000;
const HOST = "0.0.0.0";

setupFrontend()
  .then(() => {
    httpServer.listen(PORT, HOST, () => {
      console.log(`[opendex] web server listening on http://${HOST}:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[opendex] failed to start server", err);
    process.exit(1);
  });
