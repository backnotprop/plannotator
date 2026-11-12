import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface ModPlanInput {
  plan: string;
  planFilePath?: string;
  permissionMode?: string;
  revisionFile?: string;
  projectRoot?: string;
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
    ...(text("projectRoot") ? { projectRoot: text("projectRoot") } : {}),
  };
}

export interface ModPlanRevision {
  seq: number;
  plan: string;
}

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
  }
}
