import { z } from "zod";
import { meta, TOOLS } from "./meta";
import type { Skill, SkillTool } from "../types";

const DESKTOP_ONLY_ERROR = {
  error: "Desktop screen capture and mouse/keyboard control require the OpenDex desktop application.",
};

const tools: SkillTool[] = [
  {
    name: TOOLS.captureScreen,
    description:
      "Take a screenshot and look at it. (Desktop app only — unavailable in the web runtime.)",
    inputSchema: z.object({
      region: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .optional(),
      displayId: z.number().optional(),
    }),
    summarize: () => "Take a screenshot of the screen",
    execute: async () => DESKTOP_ONLY_ERROR,
  },
  {
    name: TOOLS.click,
    description: "Click the mouse at a point. (Desktop app only.)",
    inputSchema: z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      double: z.boolean().optional(),
      screenshot: z.boolean().optional(),
    }),
    summarize: () => "Click mouse",
    execute: async () => DESKTOP_ONLY_ERROR,
  },
  {
    name: TOOLS.moveMouse,
    description: "Move the mouse pointer to a point. (Desktop app only.)",
    inputSchema: z.object({ x: z.number(), y: z.number() }),
    summarize: (i) => `Move mouse to (${(i as { x: number }).x}, ${(i as { y: number }).y})`,
    execute: async () => DESKTOP_ONLY_ERROR,
  },
  {
    name: TOOLS.drag,
    description: "Drag the mouse from one point to another. (Desktop app only.)",
    inputSchema: z.object({
      fromX: z.number().optional(),
      fromY: z.number().optional(),
      toX: z.number(),
      toY: z.number(),
      button: z.enum(["left", "right", "middle"]).optional(),
      screenshot: z.boolean().optional(),
    }),
    summarize: (i) => `Drag to (${(i as { toX: number }).toX}, ${(i as { toY: number }).toY})`,
    execute: async () => DESKTOP_ONLY_ERROR,
  },
  {
    name: TOOLS.typeText,
    description: "Type text at the current focus. (Desktop app only.)",
    inputSchema: z.object({
      text: z.string(),
      method: z.enum(["type", "paste"]).optional(),
      screenshot: z.boolean().optional(),
    }),
    summarize: () => "Type text",
    execute: async () => DESKTOP_ONLY_ERROR,
  },
  {
    name: TOOLS.pressKeys,
    description: "Press a key or keyboard shortcut. (Desktop app only.)",
    inputSchema: z.object({
      keys: z.array(z.string()).min(1),
      screenshot: z.boolean().optional(),
    }),
    summarize: (i) => `Press ${(i as { keys: string[] }).keys.join(" + ")}`,
    execute: async () => DESKTOP_ONLY_ERROR,
  },
  {
    name: TOOLS.scroll,
    description: "Scroll the screen. (Desktop app only.)",
    inputSchema: z.object({
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().min(1).max(50).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      screenshot: z.boolean().optional(),
    }),
    summarize: (i) => `Scroll ${(i as { direction: string }).direction}`,
    execute: async () => DESKTOP_ONLY_ERROR,
  },
  {
    name: TOOLS.wait,
    description: "Pause briefly. (Desktop app only.)",
    inputSchema: z.object({
      ms: z.number().min(0).max(3000).optional(),
      screenshot: z.boolean().optional(),
    }),
    summarize: (i) => `Wait ${(i as { ms?: number }).ms ?? 500}ms`,
    execute: async () => DESKTOP_ONLY_ERROR,
  },
];

export const computerSkill: Skill = {
  ...meta,
  systemPrompt:
    "Note: Desktop computer control (screenshots, mouse, and keyboard injection) is disabled in the browser web runtime.",
  tools,
};
