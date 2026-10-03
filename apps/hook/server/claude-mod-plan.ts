/**
 * CLI half of the Claude Code mod's non-blocking plan review
 * (`plannotator claude-mod-plan`, internal; the mod is `apps/hook/hooks/mod/`).
 *
 * The mod answers ExitPlanMode at once and starts this subcommand detached. A
 * revision Claude submits while the review is open reaches the running server
 * through a file the mod writes (`revisionFile`), never a new endpoint: the
 * subcommand polls it, pushes a newer revision into the open tab with the plan
 * server's `updatePlan`, and acknowledges it in `<revisionFile>.ack`.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** What the mod writes on stdin when it starts the subcommand. */
export interface ModPlanInput {
  plan: string;
  planFilePath?: string;
  permissionMode?: string;
  revisionFile?: string;
}

export function parseModPlanInput(raw: string): ModPlanInput | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.plan !== "string" || !record.plan.trim()) return null;
  const text = (key: string) => (typeof record[key] === "string" && record[key] ? (record[key] as string) : undefined);
  return {
    plan: record.plan,
    planFilePath: text("planFilePath"),
    permissionMode: text("permissionMode"),
    revisionFile: text("revisionFile"),
  };
}

export interface ModPlanRevision {
  seq: number;
  plan: string;
}

/**
 * The newest revision in the file when it is newer than `afterSeq`. A file the
 * mod is still writing does not parse and reads as "nothing yet".
 */
export function readModPlanRevision(path: string, afterSeq: number): ModPlanRevision | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const seq = value.seq;
    const plan = value.plan;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq <= afterSeq) return null;
    if (typeof plan !== "string" || !plan.trim()) return null;
    return { seq, plan };
  } catch {
    return null;
  }
}

export interface ModPlanRevisionAck {
  seq: number;
  /** False when a decision was already being recorded: the mod tells Claude to wait. */
  accepted: boolean;
  revision?: number;
  version?: number;
  unchanged?: boolean;
}

export function writeModPlanRevisionAck(revisionFile: string, ack: ModPlanRevisionAck): void {
  const path = `${revisionFile}.ack`;
  const temp = `${path}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(ack), "utf8");
    renameSync(temp, path);
  } catch {
    // The mod times out waiting and tells Claude the review is still open.
  }
}
