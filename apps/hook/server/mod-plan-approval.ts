import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudePlan } from "./claude-plan";

export const MOD_PLAN_APPROVALS_DIR = "plan-approvals";
export const MOD_PLAN_APPROVAL_VERSION = 1;
export const MOD_PLAN_APPROVAL_MAX_AGE_MS = 10 * 60_000;

const MAX_RECORDS = 32;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export interface ModPlanApprovalRecord {
  v: number;
  hash: string;
  plan: string;
  permissionMode?: string;
  at: number;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function modPlanHash(plan: string): string {
  return createHash("sha256").update(plan.replace(/\s+$/, ""), "utf8").digest("hex");
}

export function modPlanApprovalsDir(dataDir: string, sessionId: unknown): string | null {
  if (typeof sessionId !== "string") return null;
  const segment = safeSegment(sessionId);
  if (!segment || /^\.+$/.test(segment)) return null;
  return join(dataDir, "claude-code-mod", segment, MOD_PLAN_APPROVALS_DIR);
}

function ownedByMe(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function parseRecord(text: string): ModPlanApprovalRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== "object") return null;
    if (value.v !== MOD_PLAN_APPROVAL_VERSION) return null;
    if (typeof value.hash !== "string" || typeof value.plan !== "string" || typeof value.at !== "number") return null;
    if (value.permissionMode !== undefined && typeof value.permissionMode !== "string") return null;
    return value as unknown as ModPlanApprovalRecord;
  } catch {
    return null;
  }
}

export interface ModPlanApprovalDecision {
  behavior: "allow";
  updatedInput: Record<string, unknown>;
  updatedPermissions?: Array<{ type: "setMode"; mode: string; destination: "session" }>;
}

export function takeModPlanApproval(
  event: Record<string, any>,
  options: { dataDir: string; now: number },
): ModPlanApprovalDecision | null {
  if (event.hook_event_name !== "PermissionRequest" || event.tool_name !== "ExitPlanMode") return null;
  if (event.agent_id) return null;
  const dir = modPlanApprovalsDir(options.dataDir, event.session_id);
  if (!dir) return null;

  let names: string[];
  try {
    const folder = lstatSync(dir);
    if (!folder.isDirectory() || !ownedByMe(folder.uid)) return null;
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort().slice(0, MAX_RECORDS);
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  const toolInput: Record<string, unknown> =
    event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
  const wanted = new Set<string>();
  for (const plan of [resolveClaudePlan(toolInput), typeof toolInput.plan === "string" ? toolInput.plan : ""]) {
    if (plan.trim()) wanted.add(modPlanHash(plan));
  }
  if (wanted.size === 0) return null;

  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || !ownedByMe(stat.uid)) continue;
      const record = parseRecord(readFileSync(path, "utf8"));
      if (!record) continue;
      if (modPlanHash(record.plan) !== record.hash) continue;
      const age = options.now - record.at;
      if (age > MOD_PLAN_APPROVAL_MAX_AGE_MS || age < -60_000) continue;
      if (!wanted.has(record.hash)) continue;
      unlinkSync(path);
      return {
        behavior: "allow",
        updatedInput: { ...toolInput, plan: record.plan },
        ...(record.permissionMode
          ? { updatedPermissions: [{ type: "setMode" as const, mode: record.permissionMode, destination: "session" as const }] }
          : {}),
      };
    } catch {
      continue;
    }
  }
  return null;
}
