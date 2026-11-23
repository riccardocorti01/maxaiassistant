import { randomUUID } from "node:crypto";
import type { PermissionRequestPayload } from "../ipc/channels";
import { getConfig, updateConfig } from "../config/store";
import type { PermissionRequester } from "../../skills/types";

export type PermissionDecision = "allow_once" | "always" | "deny" | "never";

const PERMISSION_TIMEOUT_MS = 120_000;

const pending = new Map<string, (decision: PermissionDecision) => void>();

export interface PermissionSender {
  isDestroyed: () => boolean;
  onDestroyed?: (cb: () => void) => () => void;
}

export interface PermissionUi {
  present: (req: PermissionRequestPayload) => void;
  dismiss: (id: string) => void;
}

let permissionUi: PermissionUi | null = null;
export function setPermissionUi(ui: PermissionUi) {
  permissionUi = ui;
}

export function pendingPermissions(): number {
  return pending.size;
}

export function resolvePermission(id: string, decision: PermissionDecision) {
  const resolve = pending.get(id);
  if (!resolve) return;
  pending.delete(id);
  resolve(decision);
}

export function makePermissionRequester(sender: PermissionSender): PermissionRequester {
  const sessionAllow = new Set<string>();
  return (skillId, label, detail) =>
    new Promise<boolean>((resolve) => {
      const standing = getConfig().skills.permissions[skillId];
      if (standing === "always") return resolve(true);
      if (standing === "never") return resolve(false);
      if (sessionAllow.has(skillId)) return resolve(true);

      if (sender.isDestroyed()) return resolve(false);

      const id = randomUUID();
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let offDestroyed: (() => void) | undefined;

      const settle = (decision: PermissionDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        offDestroyed?.();
        permissionUi?.dismiss(id);
        const allowed = decision === "allow_once" || decision === "always";
        if (allowed) sessionAllow.add(skillId);
        resolve(allowed);
      };

      pending.set(id, settle);
      offDestroyed = sender.onDestroyed?.(() => settle("deny"));
      timer = setTimeout(() => {
        console.warn(
          `[opendex] permission prompt for "${skillId}" auto-denied after ${PERMISSION_TIMEOUT_MS}ms with no answer`,
        );
        settle("deny");
      }, PERMISSION_TIMEOUT_MS);
      permissionUi?.present({ id, skillId, label, detail });
    });
}

export function recordAndResolve(
  id: string,
  skillId: string,
  decision: PermissionDecision,
) {
  if (decision === "always" || decision === "never") {
    const permissions = { ...getConfig().skills.permissions, [skillId]: decision };
    updateConfig({ skills: { permissions } });
  }
  resolvePermission(id, decision);
}
