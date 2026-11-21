/**
 * The record of what a plan's share put where: `<dataDir>/plan-library/<pln_id>/share.json`, beside the plan it is
 * of. Written whole through a temp file and a rename (0600), as the library writes its whole files, after every step
 * that went up, so a run that dies goes on from the step after the last one kept. One writer: the Inbox server.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPlanId } from "@plannotator/core/plans";
import { isSpaceShareRecord, type SpaceShareRecord } from "@plannotator/core/space-share";
import { planLibraryDir } from "../plans/store";

export const PLAN_SHARE_FILE = "share.json";

const pathOf = (dataDir: string, planId: string) => join(planLibraryDir(dataDir), planId, PLAN_SHARE_FILE);

export function readSpaceShareRecord(dataDir: string, planId: string): SpaceShareRecord | null {
  if (!isPlanId("pln", planId)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(pathOf(dataDir, planId), "utf8"));
    if (!isSpaceShareRecord(value)) return null;
    return { ...value, seed: value.seed ?? null, owner: value.owner ?? null, refused: value.refused === true, approval: value.approval ?? null, shared_at: value.shared_at ?? null, job: value.job ?? null };
  } catch {
    return null;
  }
}

export function saveSpaceShareRecord(dataDir: string, planId: string, record: SpaceShareRecord): void {
  if (!isPlanId("pln", planId)) throw new Error("Not a plan id.");
  const dir = join(planLibraryDir(dataDir), planId);
  if (!existsSync(dir)) throw new Error(`No plan ${planId}.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = pathOf(dataDir, planId);
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  renameSync(temp, path);
}

/** Forget the share (the space was deleted). */
export function dropSpaceShareRecord(dataDir: string, planId: string): void {
  if (isPlanId("pln", planId)) rmSync(pathOf(dataDir, planId), { force: true });
}
