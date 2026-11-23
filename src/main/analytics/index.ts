import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../config/store";

const devSkip = (): boolean =>
  process.env.NODE_ENV !== "production" && process.env.GA_DEBUG !== "1";

const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID ?? "G-HBB5QNHS90";
const GA_API_SECRET = process.env.GA_API_SECRET ?? "ShIZno_5RQavnZFZ6UjU_w";
const ENDPOINT = "https://www.google-analytics.com/mp/collect";

let clientId = "";
let sessionId = "";
let userAgent = "";

function buildUserAgent(): string {
  const webkit = "AppleWebKit/537.36 (KHTML, like Gecko)";
  return `Mozilla/5.0 (X11; Linux ${process.arch === "arm64" ? "aarch64" : "x86_64"}) ${webkit} Chrome/120.0.0.0 Safari/537.36`;
}

function loadClientId(): string {
  const dir = join(process.cwd(), ".opendex-data");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  const file = existsSync(dir)
    ? join(dir, "analytics-client-id")
    : join(tmpdir(), "opendex-analytics-client-id");
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    // fall through
  }
  const id = randomUUID();
  try {
    writeFileSync(file, id, "utf8");
  } catch {
    // ignore
  }
  return id;
}

export function initAnalytics(): void {
  clientId = loadClientId();
  sessionId = String(Date.now());
  userAgent = buildUserAgent();
}

function credsConfigured(): boolean {
  return (
    GA_MEASUREMENT_ID.startsWith("G-") &&
    GA_MEASUREMENT_ID !== "G-XXXXXXXXXX" &&
    GA_API_SECRET.length > 0
  );
}

function analyticsEnabled(): boolean {
  try {
    return getConfig().analytics.enabled;
  } catch {
    return false;
  }
}

function baseParams(): Record<string, string | number> {
  return {
    app_version: "1.1.14",
    os: process.platform,
    arch: process.arch,
    session_id: sessionId,
    engagement_time_msec: 100,
  };
}

export function track(
  name: string,
  params: Record<string, string | number | boolean> = {},
): void {
  if (devSkip() || !clientId || !credsConfigured() || !analyticsEnabled()) return;
  const url = `${ENDPOINT}?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`;
  const body = JSON.stringify({
    client_id: clientId,
    events: [{ name, params: { ...baseParams(), ...params } }],
  });
  try {
    void fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": userAgent || buildUserAgent(),
      },
      body,
    }).catch(() => {});
  } catch {
    // never throw
  }
}
