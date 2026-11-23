import { z } from "zod";
import { meta, TOOLS } from "./meta";
import type { Skill } from "../types";

export const openSkill: Skill = {
  ...meta,
  tools: [
    {
      name: TOOLS.openUrl,
      description: "Validate and prepare an http(s) or mailto URL to open.",
      inputSchema: z.object({
        url: z.string().describe("An http(s) or mailto URL."),
      }),
      summarize: (i) => `Open URL: ${(i as { url: string }).url}`,
      execute: async ({ url }: { url: string }) => {
        if (!/^(https?:|mailto:)/i.test(url)) {
          return { error: "Only http(s) and mailto URLs are allowed." };
        }
        return { ok: true, opened: url };
      },
    },
    {
      name: TOOLS.openApp,
      description: "Launch an installed desktop application by name. (Desktop app only.)",
      inputSchema: z.object({
        name: z.string().describe("Application name."),
      }),
      summarize: (i) => `Launch app: ${(i as { name: string }).name}`,
      execute: async ({ name }: { name: string }) => ({
        error: `Cannot launch local desktop app "${name}" from the web browser runtime.`,
      }),
    },
    {
      name: TOOLS.openPath,
      description: "Open a local file or folder. (Desktop app only.)",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to a file or folder."),
      }),
      summarize: (i) => `Open path: ${(i as { path: string }).path}`,
      execute: async ({ path }: { path: string }) => ({
        error: `Cannot open local filesystem path "${path}" from the web browser runtime.`,
      }),
    },
  ],
};
