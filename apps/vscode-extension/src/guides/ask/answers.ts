import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { isValidGuideId } from "@plannotator/shared/guide-store";
import type { AgentChoiceRecord } from "../store";

export interface AskAbout {
  kind: "selection" | "file" | "chapter";
  chapter: number;
  chapterTitle: string;
  path?: string;
  oldPath?: string;
  side?: "head" | "base";
  lines?: { start: number; end: number };
  code?: string;
  fileHash?: string;
  codeHash?: string;
}

export type AnswerStatus = "answering" | "answered" | "text" | "stopped" | "failed";

export interface AnswerRecord {
  v: 1;
  id: string;
  guideId: string;
  repoKey: string;
  question: string;
  about: AskAbout;
  askedAt: number;
  answeredAt?: number;
  status: AnswerStatus;
  title?: string;
  html?: string;
  text?: string;
  statusMessage?: string;
  agent: AgentChoiceRecord;
  cost?: { amount: number; currency: string };
  headSha?: string;
  session?: "loaded" | "fresh";
  followUpOf?: string;
  seen?: boolean;
}

const ANSWER_ID_RE = /^ans-\d+-[a-z0-9]{4,8}$/;
const MAX_CODE_CHARS = 8000;

export function newAnswerId(now = Date.now()): string {
  return `ans-${now}-${Math.random().toString(36).slice(2, 8).padEnd(4, "0")}`;
}

export function isValidAnswerId(id: string): boolean {
  return ANSWER_ID_RE.test(id);
}

export function capCode(code: string): string {
  return code.length > MAX_CODE_CHARS ? `${code.slice(0, MAX_CODE_CHARS)}\n…` : code;
}

function answersDir(repoKey: string, guideId: string): string {
  return join(getPlannotatorDataDir(), "guides", repoKey, "vscode", "answers", guideId);
}

export function answersPath(repoKey: string, guideId: string): string {
  return answersDir(repoKey, guideId);
}

export function saveAnswer(record: AnswerRecord): void {
  if (!isValidGuideId(record.guideId) || !isValidAnswerId(record.id)) throw new Error(`Bad answer id ${record.guideId}/${record.id}`);
  const dir = answersDir(record.repoKey, record.guideId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.id}.json`);
  writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2), "utf8");
  renameSync(`${path}.tmp`, path);
}

export function parseAnswer(value: unknown): AnswerRecord | null {
  if (!value || typeof value !== "object") return null;
  const r = value as AnswerRecord;
  if (r.v !== 1 || typeof r.id !== "string" || !isValidAnswerId(r.id) || typeof r.guideId !== "string" || typeof r.question !== "string") return null;
  if (!r.about || typeof r.about !== "object" || typeof r.about.chapter !== "number" || !r.agent) return null;
  if (r.status === "answering") return { ...r, status: "stopped", statusMessage: r.statusMessage ?? "VS Code closed before the answer arrived." };
  return r;
}

export function loadAnswer(repoKey: string, guideId: string, id: string): AnswerRecord | null {
  if (!isValidGuideId(guideId) || !isValidAnswerId(id)) return null;
  try {
    return parseAnswer(JSON.parse(readFileSync(join(answersDir(repoKey, guideId), `${id}.json`), "utf8")));
  } catch {
    return null;
  }
}

export function listAnswers(repoKey: string, guideId: string): AnswerRecord[] {
  if (!isValidGuideId(guideId)) return [];
  let names: string[];
  try {
    names = readdirSync(answersDir(repoKey, guideId));
  } catch {
    return [];
  }
  const out: AnswerRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const r = loadAnswer(repoKey, guideId, name.slice(0, -5));
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.askedAt - a.askedAt);
}

export function deleteAnswer(repoKey: string, guideId: string, id: string): void {
  if (!isValidGuideId(guideId) || !isValidAnswerId(id)) return;
  rmSync(join(answersDir(repoKey, guideId), `${id}.json`), { force: true });
}

export function deleteGuideAnswers(repoKey: string, guideId: string): void {
  if (!isValidGuideId(guideId)) return;
  rmSync(answersDir(repoKey, guideId), { recursive: true, force: true });
}

export function linesHash(text: string): string {
  return createHash("sha1").update(text.replace(/\r\n?/g, "\n").replace(/\n$/, "")).digest("hex");
}

export function fileLinesHash(fileText: string, start: number, end: number): string | null {
  const lines = fileText.replace(/\r\n?/g, "\n").split("\n");
  if (end > lines.length || start < 1 || end < start) return null;
  return linesHash(lines.slice(start - 1, end).join("\n"));
}

export function staleNote(record: AnswerRecord, current: { fileHash?: string | null; codeHash?: string | null; headSha?: string | null }): string | null {
  const sha = record.headSha?.slice(0, 7);
  const about = record.about;
  if (about.codeHash) {
    if (current.codeHash !== undefined && current.codeHash !== about.codeHash) return `Written for ${sha ?? "an earlier version"}; these lines have changed since.`;
    return null;
  }
  if (about.fileHash && about.side !== "base") {
    if (current.fileHash !== undefined && current.fileHash !== about.fileHash) return `Written for ${sha ?? "an earlier version"}; the file has changed since.`;
    return null;
  }
  if (about.side === "base") return null;
  if (record.headSha && current.headSha && current.headSha !== record.headSha) return `Written for ${sha}; the change has moved since.`;
  return null;
}
