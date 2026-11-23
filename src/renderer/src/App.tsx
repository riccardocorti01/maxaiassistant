import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { UpdateBanner } from "@/components/update-banner";
import { getDexTheme } from "@/components/themes/registry";
import { useConfig } from "@/lib/use-config";
import { useDex, type UseDexOptions } from "@/lib/dex/use-dex";
import { usePermission } from "@/lib/use-permission";
import { PermissionPrompt } from "@/components/permission-prompt";
import { SettingsApp } from "@/components/settings/settings-view";
import { OverlayApp } from "./OverlayApp";
import { NotchApp } from "./NotchApp";
import { webShellStore } from "@/lib/web-bridge";
import type { OpenDexConfig, PublicConfig } from "../../main/config/schema";
import type { WindowMode } from "../../main/ipc/channels";

export function App() {
  const { data, loading, setConfig, setSecret, completeOnboarding } = useConfig();
  const [settingsOpen, setSettingsOpen] = useState(() => webShellStore.getSettingsOpen());
  const permission = usePermission();

  useEffect(() => webShellStore.onSettingsOpen(setSettingsOpen), []);

  // Close settings modal automatically if config is reset back to onboarding
  useEffect(() => {
    if (data && !data.config.onboarding.completed && settingsOpen) {
      webShellStore.setSettingsOpen(false);
    }
  }, [data, settingsOpen]);

  // Escape closes settings modal
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") webShellStore.setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  if (loading || !data) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div className="font-mono text-xs uppercase tracking-[0.4em] text-white/30">
          OpenDex
        </div>
      </main>
    );
  }

  return (
    <>
      {!data.config.onboarding.completed ? (
        <OnboardingWizard
          data={data}
          setConfig={setConfig}
          setSecret={setSecret}
          onComplete={completeOnboarding}
        />
      ) : (
        <MainExperience data={data} />
      )}

      {/* In-browser Settings modal (replaces Electron settings BrowserWindow) */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="relative flex h-[min(720px,88vh)] w-full max-w-4xl overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
            <button
              type="button"
              onClick={() => webShellStore.setSettingsOpen(false)}
              aria-label="Close settings"
              className="absolute right-4 top-4 z-10 flex size-8 items-center justify-center rounded-full border border-border bg-dex-surface/80 text-muted-foreground transition hover:text-foreground"
            >
              <X className="size-4" />
            </button>
            <SettingsApp />
          </div>
        </div>
      )}

      {/* In-browser Permission prompt modal (replaces Electron permission popup) */}
      {permission.current && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <PermissionPrompt request={permission.current} onRespond={permission.respond} />
        </div>
      )}
    </>
  );
}

function greetingEnabled(config: OpenDexConfig): boolean {
  if (config.greeting.mode === "none") return false;
  if (config.greeting.mode === "custom") {
    return config.greeting.customPrompt.trim().length > 0;
  }
  return true;
}

function MainExperience({ data }: { data: PublicConfig }) {
  const cfg = data.config;
  const [windowMode, setWindowMode] = useState<WindowMode>(() =>
    webShellStore.getWindowMode(),
  );
  const [notchSize, setNotchSize] = useState(() => webShellStore.getNotchSize());

  useEffect(() => window.opendex.onWindowMode(setWindowMode), []);
  useEffect(() => webShellStore.onNotchSize(setNotchSize), []);

  const dexOptions = useMemo<UseDexOptions>(
    () => ({
      voiceMode: cfg.voice.mode,
      realtimeIdleDisconnectSec: cfg.realtime.idleDisconnectSec,
      wakeWord: cfg.assistant.wakeWord,
      wakeMode: cfg.voiceInput.wakeMode,
      sttProvider: cfg.voiceInput.sttProvider,
      whisperModel: cfg.voiceInput.whisperModel,
      greetingEnabled: greetingEnabled(cfg),
      ttsEngine: cfg.tts.engine,
      systemVoice: cfg.tts.system,
      showToolActivity: cfg.appearance.showToolActivity,
    }),
    [
      cfg.voice.mode,
      cfg.realtime.idleDisconnectSec,
      cfg.assistant.wakeWord,
      cfg.voiceInput.wakeMode,
      cfg.voiceInput.sttProvider,
      cfg.voiceInput.whisperModel,
      cfg.greeting.mode,
      cfg.greeting.customPrompt,
      cfg.tts.engine,
      cfg.tts.system,
      cfg.appearance.showToolActivity,
    ],
  );

  const dex = useDex(dexOptions);
  const ThemeComponent = getDexTheme(cfg.appearance.theme).Component;

  useEffect(
    () =>
      window.opendex.onSummoned(() =>
        window.dispatchEvent(new Event("opendex:summon")),
      ),
    [],
  );

  const { submitText, toggleMute, newConversation } = dex;
  useEffect(
    () =>
      window.opendex.onRemoteCommand((cmd) => {
        if (cmd.type === "submitText") submitText(cmd.text);
        else if (cmd.type === "toggleMute") toggleMute();
        else if (cmd.type === "newConversation") newConversation();
      }),
    [submitText, toggleMute, newConversation],
  );

  return (
    <div className="relative flex flex-1 flex-col">
      <div className={windowMode === "notch" ? "hidden" : "flex flex-1 flex-col"}>
        <ThemeComponent
          name={cfg.assistant.name}
          wakeWord={cfg.assistant.wakeWord}
          status={dex.status}
          transcript={dex.transcript}
          liveCaption={dex.liveCaption}
          spokenCaption={dex.spokenCaption}
          getAmplitude={dex.getAmplitude}
          toolInvocations={dex.toolInvocations}
          onNewConversation={dex.newConversation}
          isMuted={dex.isMuted}
          briefingActive={dex.briefingActive}
          unsupported={dex.status === "unsupported"}
          canPushToTalk={dex.canPushToTalk}
          onPushToTalk={dex.pushToTalk}
          onSubmitText={dex.submitText}
          toggleMute={dex.toggleMute}
          onOpenSettings={() => window.opendex.openSettings()}
          onMinimize={() => window.opendex.setWindowMode("notch")}
        />
      </div>

      {/* Compact notch mode inside the browser viewport */}
      {windowMode === "notch" && (
        <div className="flex flex-1 flex-col items-center justify-center p-6">
          <div className="fixed inset-x-0 top-0 z-40 flex justify-center pointer-events-none">
            <div
              className="pointer-events-auto shadow-2xl transition-all duration-200"
              style={{ width: notchSize.width, height: notchSize.height }}
            >
              <NotchApp />
            </div>
          </div>
          <div className="text-center text-xs text-muted-foreground">
            OpenDex is running in compact notch mode above. Hover the bar or click expand to return.
          </div>
        </div>
      )}

      {/* In-browser Overlay HUD (tool activity banners + Stop control) */}
      <OverlayApp />

      {dex.loadingModel.active && (
        <div className="fixed inset-x-0 top-16 z-30 flex justify-center">
          <div className="flex items-center gap-3 rounded-full border border-border bg-dex-surface/85 px-5 py-2 text-sm text-foreground/80 backdrop-blur">
            <span className="h-2 w-2 animate-pulse rounded-full bg-foreground" />
            {dex.loadingModel.label || "Loading voice model…"}
          </div>
        </div>
      )}

      <UpdateBanner />

      {dex.audioBlocked && (
        <button
          type="button"
          onClick={dex.unlockAudio}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background/90 backdrop-blur-sm text-foreground"
          aria-label="Tap to enable audio"
        >
          <div className="font-mono text-xs uppercase tracking-[0.4em] text-muted-foreground">
            Audio paused
          </div>
          <div className="text-2xl font-light">Tap anywhere to enable audio</div>
          <div className="max-w-sm text-center text-xs text-muted-foreground">
            Audio playback needs a single interaction to start. Once enabled,
            OpenDex will speak automatically from here on.
          </div>
        </button>
      )}
    </div>
  );
}
