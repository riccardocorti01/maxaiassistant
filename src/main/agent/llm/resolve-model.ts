import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import type { OpenDexConfig } from "../../config/schema";

/** Result of probing whether the Apple on-device model can be used right now. */
export interface AppleAvailability {
  available: boolean;
  /** Human-readable reason when unavailable (OS too old, Intelligence off, …). */
  reason?: string;
}

/**
 * Maps the configured provider to a concrete AI SDK model. Returns either a
 * `LanguageModel` instance (direct providers) or a bare model-id string
 * (the gateway path, resolved by the SDK's global Vercel AI Gateway provider).
 */
export async function resolveModel(config: OpenDexConfig): Promise<LanguageModel> {
  const { provider, model } = config.llm;
  switch (provider) {
    case "openai":
      if (!process.env.OPENAI_API_KEY) throw new Error("no OpenAI API key is set");
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(model);
    case "anthropic":
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("no Anthropic API key is set");
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(model);
    case "xai":
      if (!process.env.XAI_API_KEY) throw new Error("no xAI API key is set");
      return createXai({ apiKey: process.env.XAI_API_KEY })(model);
    case "apple":
      throw new Error("Apple Intelligence requires macOS on Apple Silicon");
    case "opendex":
      throw new Error("the OpenDex subscription isn't available yet");
    case "gateway":
    default:
      if (!process.env.AI_GATEWAY_API_KEY) {
        throw new Error("no Vercel AI Gateway API key is set");
      }
      return model;
  }
}

/** Probe Apple on-device availability for the UI (always unavailable in web/Linux runtime). */
export async function checkAppleAvailability(): Promise<AppleAvailability> {
  return { available: false, reason: "Requires macOS on Apple Silicon (Desktop App)" };
}
