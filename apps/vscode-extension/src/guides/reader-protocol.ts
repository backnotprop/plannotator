/**
 * Messages between the Guide tab (the reader webview: Plannotator's guide
 * reader, `src/guides/reader/`) and the extension. Types and the
 * extension-side checks only; no `vscode`, no DOM. The reader draws the
 * guide and asks; the extension answers with what the language server and
 * the files on disk say. Every message the reader sends is checked here
 * before it is acted on (`parseReaderMessage`); anything that does not have
 * the exact shape is dropped.
 */

import type { GuideSnapshot } from "@plannotator/core/guide-format";

/** A position in one side of a file's diff, as the reader's diff reports it. */
export interface DiffPosition {
  /** Repo-relative path of the file in the change (its new path for a rename). */
  path: string;
  /** `new`: the head side (the real file); `old`: the base side. */
  side: "old" | "new";
  /** 1-based line on that side. */
  line: number;
  /** 0-based character on that line. */
  character: number;
  /** The token under the pointer, used to check the file still has it there. */
  token: string;
}

/** What the reader needs to draw the guide. */
export interface ReaderInit {
  guideId: string;
  /** "PR #482 · Retry failed webhook deliveries …". */
  title: string;
  label: string;
  snapshot: GuideSnapshot;
  reviewed: boolean[];
  /** Files ticked "Viewed" (a chapter ticks itself when all its files are). */
  fileTicks: string[];
  /** One CSS color per chapter (the tree's and the status bar's chapter colors). */
  chapterColors: string[];
  /** The guide's head is no longer what the reader shows. */
  moved: boolean;
  /** Paths whose file on disk differs from the guide's head (local changes edited since). */
  changedSince: string[];
  /** `mac` shows ⌘, anything else Ctrl. */
  platform: "mac" | "other";
  /** Who answers questions ("Claude Code"), when asking is possible. */
  askAgent: string | null;
  /** The chapter to show first (0-based). */
  startChapter: number;
}

/** A hover answer drawn as the reader's card. */
export interface HoverAnswer {
  /** The symbol, as the language server spells it (else the token). */
  symbol: string;
  /** The language server's hover: code blocks (signatures) and markdown, in order. */
  blocks: Array<{ kind: "code"; language: string; text: string } | { kind: "markdown"; text: string }>;
  /**
   * Where it is defined (the first definition), repo-relative when inside the
   * repository. `side` says which version holds it: `new` the head (the file on
   * disk or the head revision), `old` the base revision (a definition found
   * from a removed line), null a file outside the guide's sides.
   */
  definition: { path: string; line: number; character: number; inRepo: boolean; side: "old" | "new" | null } | null;
  /** The chapter that changed the definition's file, when it is in the guide. */
  chapter: { n: number; title: string; reviewed: boolean; color: string } | null;
  /** Filled in by a later `references` message (a references search can take longer). */
  referenceCount: number | null;
  /** The file on disk no longer has this token here (it changed since the guide was written). */
  stale: boolean;
  /** Milliseconds the extension spent (hover + definition). */
  elapsedMs: number;
}

export interface AnswerMarker {
  id: string;
  path: string;
  /** The side of the diff the lines are on (`new`: head lines, `old`: base lines). */
  side: "old" | "new";
  /** Lines the question was about, on that side. */
  start: number;
  end: number;
  question: string;
  status: "answering" | "answered" | "text" | "stopped" | "failed";
}

export interface ChapterAnswers {
  chapter: number;
  items: Array<{ id: string; question: string; sub: string; when: string; status: AnswerMarker["status"]; isNew: boolean }>;
}

export type ToReader =
  | { type: "init"; init: ReaderInit }
  | { type: "reviewed"; reviewed: boolean[]; fileTicks: string[] }
  | { type: "hover"; reqId: number; answer: HoverAnswer | null }
  | { type: "references"; reqId: number; count: number | null }
  /** Scroll the reader to a chapter, or to a file (and a line on one side of its diff). */
  | { type: "reveal"; path?: string; chapter?: number; line?: number; side?: "old" | "new" }
  | { type: "asks"; busy: boolean; markers: AnswerMarker[]; chapters: ChapterAnswers[]; agent: string | null }
  | { type: "notice"; text: string }
  | { type: "checkMermaid"; reqId: number; source: string };

export type NavigateAction = "definition" | "references" | "open";

export type FromReader =
  | { type: "ready" }
  | { type: "hover"; reqId: number; at: DiffPosition }
  | { type: "references"; reqId: number; at: DiffPosition }
  | { type: "navigate"; at: DiffPosition; action: NavigateAction }
  | { type: "toggleReviewed"; chapter: number }
  | { type: "toggleFileReviewed"; path: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openDiff"; path: string }
  /** A definition's place from the hover card: `old` opens the base revision's document. */
  | { type: "openLocation"; path: string; line: number; character: number; side: "old" | "new" }
  | { type: "chapter"; chapter: number }
  /** A question about a chapter, or about lines `start`..`end` on one `side` of a file's diff. */
  | { type: "ask"; question: string; chapter?: number; path?: string; side?: "old" | "new"; start?: number; end?: number }
  | { type: "openAnswer"; id: string }
  | { type: "command"; command: "export" | "outline" | "refresh" }
  | { type: "metric"; name: string; ms: number }
  | { type: "link"; href: string; action: NavigateAction }
  | { type: "mermaidResult"; reqId: number; ok: boolean; message?: string; line?: number; unavailable?: boolean };

const MAX_PATH = 4096;
const MAX_TOKEN = 512;
const MAX_QUESTION = 4000;

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function isPath(v: unknown): v is string {
  // Repo-relative only: no absolute paths, no `..` segments, no NUL.
  return typeof v === "string" && v.length > 0 && v.length <= MAX_PATH && !v.startsWith("/") && !v.includes("\0") && !/^[A-Za-z]:/.test(v) && !v.split(/[\\/]/).includes("..");
}

function position(v: unknown): DiffPosition | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (!isPath(p.path)) return null;
  if (p.side !== "old" && p.side !== "new") return null;
  if (!isInt(p.line, 1, 10_000_000) || !isInt(p.character, 0, 1_000_000)) return null;
  if (typeof p.token !== "string" || p.token.length > MAX_TOKEN) return null;
  return { path: p.path, side: p.side, line: p.line, character: p.character, token: p.token };
}

/**
 * The reader's message, or null when it is not one the extension accepts.
 * Unknown types, extra-long strings, absolute or `..` paths and non-integer
 * positions are all refused. Optional fields that are present must be valid.
 */
export function parseReaderMessage(raw: unknown): FromReader | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "hover":
    case "references": {
      const at = position(m.at);
      if (!at || !isInt(m.reqId, 0, Number.MAX_SAFE_INTEGER)) return null;
      return { type: m.type, reqId: m.reqId, at };
    }
    case "navigate": {
      const at = position(m.at);
      if (!at || (m.action !== "definition" && m.action !== "references" && m.action !== "open")) return null;
      return { type: "navigate", at, action: m.action };
    }
    case "toggleReviewed":
    case "chapter":
      return isInt(m.chapter, 0, 10_000) ? { type: m.type, chapter: m.chapter } : null;
    case "openFile":
      if (!isPath(m.path)) return null;
      if (m.line !== undefined && !isInt(m.line, 1, 10_000_000)) return null;
      return { type: "openFile", path: m.path, ...(m.line !== undefined && { line: m.line as number }) };
    case "openDiff":
      return isPath(m.path) ? { type: "openDiff", path: m.path } : null;
    case "toggleFileReviewed":
      return isPath(m.path) ? { type: "toggleFileReviewed", path: m.path } : null;
    case "openLocation":
      if (!isPath(m.path) || !isInt(m.line, 1, 10_000_000) || !isInt(m.character, 0, 1_000_000)) return null;
      if (m.side !== undefined && m.side !== "old" && m.side !== "new") return null;
      return { type: "openLocation", path: m.path, line: m.line, character: m.character, side: m.side === "old" ? "old" : "new" };
    case "ask": {
      // A question with something in it: a blank one asks nothing.
      if (typeof m.question !== "string" || m.question.length > MAX_QUESTION || !m.question.trim()) return null;
      const out: Extract<FromReader, { type: "ask" }> = { type: "ask", question: m.question };
      if (m.chapter !== undefined) {
        if (!isInt(m.chapter, 0, 10_000)) return null;
        out.chapter = m.chapter;
      }
      if (m.path !== undefined) {
        if (!isPath(m.path) || !isInt(m.start, 1, 10_000_000) || !isInt(m.end, 1, 10_000_000) || (m.end as number) < (m.start as number)) return null;
        if (m.side !== undefined && m.side !== "old" && m.side !== "new") return null;
        out.path = m.path;
        out.side = m.side === "old" ? "old" : "new";
        out.start = m.start as number;
        out.end = m.end as number;
      }
      if (out.chapter === undefined && out.path === undefined) return null;
      return out;
    }
    case "openAnswer":
      return typeof m.id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(m.id) ? { type: "openAnswer", id: m.id } : null;
    case "command":
      return m.command === "export" || m.command === "outline" || m.command === "refresh" ? { type: "command", command: m.command } : null;
    case "metric":
      return typeof m.name === "string" && /^[a-z][a-zA-Z0-9.-]{0,40}$/.test(m.name) && typeof m.ms === "number" && Number.isFinite(m.ms) && m.ms >= 0 ? { type: "metric", name: m.name, ms: m.ms } : null;
    case "link":
      // A guide link from the overview or a chapter (`code:`, `symbol:`, `chapter:`); the extension parses it again.
      return typeof m.href === "string" && m.href.length <= 2048 && /^(code|symbol|chapter):/.test(m.href) && (m.action === "definition" || m.action === "references" || m.action === "open")
        ? { type: "link", href: m.href, action: m.action }
        : null;
    case "mermaidResult":
      if (!isInt(m.reqId, 0, Number.MAX_SAFE_INTEGER) || typeof m.ok !== "boolean") return null;
      return {
        type: "mermaidResult",
        reqId: m.reqId,
        ok: m.ok,
        ...(typeof m.message === "string" && { message: m.message.slice(0, 2000) }),
        ...(isInt(m.line, 1, 1_000_000) && { line: m.line }),
        ...(m.unavailable === true && { unavailable: true }),
      };
    default:
      return null;
  }
}
