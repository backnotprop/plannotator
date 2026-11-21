/**
 * Answers to questions asked about a guide, saved with it: one JSON file per
 * answer under `guides/{repo-key}/vscode/answers/{guide-id}/` (VS Code's own
 * shelf, which the shared guide store never reads). They stay in VS Code: an
 * exported or shared guide carries none. Deleting the guide deletes them.
 *
 * With guide history off nothing is written: the controller keeps answers in
 * memory for the session, through the same functions with `memory` set.
 *
 * No `vscode` here.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { isValidGuideId } from "@plannotator/shared/guide-store";
import type { AgentChoiceRecord } from "../store";

/** What a question is about. Lines are 1-based, on the side named. */
export interface AskAbout {
  kind: "selection" | "file" | "chapter";
  /** 0-based chapter index. */
  chapter: number;
  chapterTitle: string;
  path?: string;
  /** The file's path in the old version, when the question is about it there and the change renamed it. */
  oldPath?: string;
  side?: "head" | "base";
  lines?: { start: number; end: number };
  /** The selected code, as it was when asked (capped). */
  code?: string;
  /** SHA-1 of the head file when asked (a question about the whole file), to tell later that it changed. */
  fileHash?: string;
  /** SHA-1 of the lines asked about (`linesHash`), as they were asked: the stale note compares the same lines now. */
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
  /** The page from `show_answer`. */
  title?: string;
  html?: string;
  /** The agent's last message, when it answered in text (or what streamed before a stop). */
  text?: string;
  statusMessage?: string;
  agent: AgentChoiceRecord;
  cost?: { amount: number; currency: string };
  /** The head commit the answer was written for. */
  headSha?: string;
  /** Whether the guide's own session answered (`loaded`) or a new one seeded with the guide. */
  session?: "loaded" | "fresh";
  /** The answer this one follows up on (same conversation). */
  followUpOf?: string;
  /** Opened in a tab at least once (the chapter list marks the others "new"). */
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

/** The selected code, capped for storage and the prompt. */
export function capCode(code: string): string {
  return code.length > MAX_CODE_CHARS ? `${code.slice(0, MAX_CODE_CHARS)}\n…` : code;
}

function answersDir(repoKey: string, guideId: string): string {
  return join(getPlannotatorDataDir(), "guides", repoKey, "vscode", "answers", guideId);
}

/** Where the answers of a guide live on disk (for tests and diagnostics). */
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
  // A run that was answering when VS Code closed did not finish.
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

/** A guide's answers, newest first. */
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

/** Every answer of a guide (the guide is being deleted). */
export function deleteGuideAnswers(repoKey: string, guideId: string): void {
  if (!isValidGuideId(guideId)) return;
  rmSync(answersDir(repoKey, guideId), { recursive: true, force: true });
}

/** SHA-1 of some lines of text, line endings and a final line break ignored (`codeHash`). */
export function linesHash(text: string): string {
  return createHash("sha1").update(text.replace(/\r\n?/g, "\n").replace(/\n$/, "")).digest("hex");
}

/** `linesHash` of lines `start`–`end` (1-based) of a file's text; null when the file is shorter. */
export function fileLinesHash(fileText: string, start: number, end: number): string | null {
  const lines = fileText.replace(/\r\n?/g, "\n").split("\n");
  if (end > lines.length || start < 1 || end < start) return null;
  return linesHash(lines.slice(start - 1, end).join("\n"));
}

/**
 * "Written for 9b07e4d; these lines have changed since." when what the
 * question was about is no longer what it was: the lines asked about (their
 * text then and now), the whole file for a question about a file, else the
 * change's head. `current` gives the same things now (`undefined`: not known;
 * `null`: gone). The base side never moves.
 */
export function staleNote(record: AnswerRecord, current: { fileHash?: string | null; codeHash?: string | null; headSha?: string | null }): string | null {
  const sha = record.headSha?.slice(0, 7);
  const about = record.about;
  if (about.codeHash) {
    if (current.codeHash !== undefined && current.codeHash !== about.codeHash) return `Written for ${sha ?? "an earlier version"}; these lines have changed since.`;
    return null;
  }
  // A base-side question of an older record carried the head's hash: it says nothing about the old lines.
  if (about.fileHash && about.side !== "base") {
    if (current.fileHash !== undefined && current.fileHash !== about.fileHash) return `Written for ${sha ?? "an earlier version"}; the file has changed since.`;
    return null;
  }
  if (about.side === "base") return null;
  if (record.headSha && current.headSha && current.headSha !== record.headSha) return `Written for ${sha}; the change has moved since.`;
  return null;
}
