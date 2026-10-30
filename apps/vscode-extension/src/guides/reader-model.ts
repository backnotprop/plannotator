/**
 * A saved guide as the VS Code reader uses it (SPEC 3.4): chapters, their
 * files, chapter ticks (the format's `reviewed[]`), file ticks (sidecar), and
 * where each side of a file's diff comes from. No `vscode` import.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GuideOverview } from "@plannotator/core/guide";
import type { GuideFocusRange } from "./core/adapter";
import { changedFilesFromPatch, commitExists, type ChangedFileInfo } from "./sources/git";
import { ensureWorktreeAt, fetchPullRequestHead, pullRequestWorktreePath } from "./sources/github";
import type { Runner } from "./sources/runner";
import type { LoadedGuide, ReviewSourceRecord } from "./store";

export interface ReaderChapter {
  title: string;
  overview: string;
  files: Array<{ path: string; summary: string }>;
}

/** Where the two sides of every diff come from. */
export interface ReaderSides {
  /** Repository the base side is read from (`git show <baseRev>:<path>`). */
  gitRoot: string;
  baseRev: string;
  /** The head side: real files under a directory, or `git show <rev>:<path>`. */
  head: { kind: "fs"; root: string } | { kind: "rev"; rev: string };
  /** The guide's head is no longer what the reader shows. */
  moved: boolean;
}

export class ReaderModel {
  readonly chapters: ReaderChapter[];
  readonly files = new Map<string, ChangedFileInfo>();
  readonly unplaced: string[];
  readonly overview: GuideOverview | null;
  reviewed: boolean[];
  fileTicks: Set<string>;
  currentChapter = 0;

  constructor(readonly loaded: LoadedGuide) {
    const guide = loaded.envelope.guide as typeof loaded.envelope.guide & { overview?: GuideOverview };
    this.chapters = guide.sections.map((s) => ({
      title: s.title,
      overview: s.overview,
      files: s.diffs.map((d) => ({ path: d.file, summary: d.summary ?? "" })),
    }));
    this.unplaced = guide.unplacedFiles ?? [];
    this.overview = guide.overview ?? null;
    this.reviewed = this.chapters.map((_, i) => loaded.envelope.reviewed[i] === true);
    for (const f of changedFilesFromPatch(loaded.rawPatch ?? "")) this.files.set(f.path, f);
    // Ticks are for the guide's own files: anything else in the sidecar is dropped.
    this.fileTicks = new Set(loaded.sidecar.fileTicks.filter((p) => this.isGuideFile(p)));
  }

  get id(): string {
    return this.loaded.id;
  }

  get title(): string {
    return this.loaded.envelope.title;
  }

  get source(): ReviewSourceRecord | undefined {
    return this.loaded.sidecar.source;
  }

  /** Every file in reading order, chapter by chapter. */
  orderedFiles(): Array<{ chapter: number; path: string }> {
    return this.chapters.flatMap((c, chapter) => c.files.map((f) => ({ chapter, path: f.path })));
  }

  chapterOf(path: string): number {
    return this.chapters.findIndex((c) => c.files.some((f) => f.path === path));
  }

  /** The file after `path` in reading order (wrapping to nothing at the end). */
  nextFile(path: string | null): { chapter: number; path: string } | null {
    const order = this.orderedFiles();
    if (!path) return order[0] ?? null;
    const i = order.findIndex((o) => o.path === path);
    return order[i + 1] ?? null;
  }

  /** The next file not ticked yet, starting after `path`. */
  nextUnreviewedFile(path: string | null): { chapter: number; path: string } | null {
    const order = this.orderedFiles();
    const start = path ? order.findIndex((o) => o.path === path) + 1 : 0;
    for (let k = 0; k < order.length; k++) {
      const o = order[(start + k) % order.length];
      if (!this.fileTicks.has(o.path)) return o;
    }
    return null;
  }

  /**
   * Tick or untick a file. A chapter ticks itself when all its files are
   * ticked (SPEC 3.4) and unticks when one is unticked. Returns the chapter
   * ticks that changed.
   */
  /** A file the guide shows (a changed file placed in a chapter or left unplaced). */
  isGuideFile(path: string): boolean {
    return this.files.has(path);
  }

  setFileReviewed(path: string, reviewed: boolean): number[] {
    if (!this.isGuideFile(path)) return [];
    if (reviewed) this.fileTicks.add(path);
    else this.fileTicks.delete(path);
    const chapter = this.chapterOf(path);
    if (chapter < 0) return [];
    const all = this.chapters[chapter].files.every((f) => this.fileTicks.has(f.path));
    if (all !== this.reviewed[chapter]) {
      this.reviewed[chapter] = all;
      return [chapter];
    }
    return [];
  }

  /** Tick a whole chapter: its files follow. */
  setChapterReviewed(chapter: number, reviewed: boolean): void {
    if (!this.chapters[chapter]) return;
    this.reviewed[chapter] = reviewed;
    for (const f of this.chapters[chapter].files) {
      if (reviewed) this.fileTicks.add(f.path);
      else this.fileTicks.delete(f.path);
    }
  }

  filesReviewedCount(): number {
    return this.orderedFiles().filter((o) => this.fileTicks.has(o.path)).length;
  }

  /** Head ranges the agent marked as the part that matters, hunks resolved to lines. */
  focusRanges(path: string): Array<{ start: number; end: number }> {
    const raw = (this.loaded.sidecar.focus[path] ?? []) as readonly GuideFocusRange[];
    const hunks = this.files.get(path)?.hunks ?? [];
    return raw.flatMap((r) => ("hunk" in r ? (hunks[r.hunk - 1] ? [hunks[r.hunk - 1]] : []) : [{ start: r.start, end: r.end }]));
  }
}

/**
 * The PR worktree a guide reads its head from (`pr-<n>-<sha7>` under the
 * extension's storage), or null for a guide of local changes. Guides made in
 * the web app have no sidecar; the envelope names the PR and its head.
 */
export function guideWorktreePath(loaded: LoadedGuide, storageDir: string): string | null {
  const env = loaded.envelope;
  const kind = loaded.sidecar.source?.kind ?? env.review?.source.kind;
  const prNumber = loaded.sidecar.source?.pr?.number ?? env.review?.source.pr?.number;
  const headSha = loaded.sidecar.source?.headSha ?? env.headSha ?? env.review?.source.headSha;
  if (kind !== "pr" || prNumber === undefined || !headSha) return null;
  return pullRequestWorktreePath(storageDir, loaded.repoKey, prNumber, headSha);
}

/**
 * Work out both sides of the guide's diffs. A guide made in VS Code knows its
 * source (sidecar); a guide made in the web app is read from its envelope.
 * A PR's head is a worktree under the extension's storage, created again at
 * the guide's head when it is missing.
 */
export async function resolveReaderSides(
  runner: Runner,
  loaded: LoadedGuide,
  options: { repoRoot: string | null; storageDir: string; onStep?: (step: string) => void },
): Promise<ReaderSides | { error: string }> {
  const g = (args: string[], cwd: string) => runner("git", ["--no-pager", ...args], { cwd, timeoutMs: 120_000, env: { GIT_TERMINAL_PROMPT: "0" } });
  const sidecar = loaded.sidecar.source;
  const env = loaded.envelope;
  const repoRoot = sidecar?.repoRoot && existsSync(sidecar.repoRoot) ? sidecar.repoRoot : options.repoRoot;
  if (!repoRoot) return { error: "Open the guide's repository in VS Code to read it here." };
  const headSha = sidecar?.headSha ?? env.headSha ?? env.review?.source.headSha;
  const prNumber = sidecar?.pr?.number ?? env.review?.source.pr?.number;
  const kind = sidecar?.kind ?? env.review?.source.kind ?? "local";

  if (kind === "pr" && prNumber !== undefined) {
    if (!headSha) return { error: "This guide does not record the PR's head commit." };
    const path = pullRequestWorktreePath(options.storageDir, loaded.repoKey, prNumber, headSha);
    if (!(await commitExists(runner, repoRoot, headSha))) {
      options.onStep?.(`Fetching PR #${prNumber}`);
      const f = await fetchPullRequestHead(runner, repoRoot, prNumber, headSha);
      if (!f.ok) return { error: `The guide's head commit ${headSha.slice(0, 7)} is not on GitHub any more (the PR was force-pushed).` };
    }
    if (!existsSync(join(path, ".git"))) options.onStep?.("Creating a worktree at the guide's head");
    const wt = await ensureWorktreeAt(runner, repoRoot, path, headSha, options.storageDir);
    if (!wt.ok) return { error: `Could not create a worktree for PR #${prNumber}: ${wt.error}` };
    const baseRev = sidecar?.baseSha ?? (await mergeBaseFor(runner, repoRoot, env.review?.base, headSha));
    if (!baseRev) return { error: "Could not find the commit this PR branches off." };
    return { gitRoot: path, baseRev, head: { kind: "fs", root: path }, moved: false };
  }

  if (kind === "commit" && env.review?.source.commitSha) {
    const sha = env.review.source.commitSha;
    return { gitRoot: repoRoot, baseRev: `${sha}^`, head: { kind: "rev", rev: sha }, moved: false };
  }

  if (kind === "workspace") return { error: "Guided reviews of a multi-repository workspace open in Plannotator's web app only." };

  // Local changes: the head is the working tree (the real files).
  const baseRev = sidecar?.baseSha ?? (await mergeBaseFor(runner, repoRoot, env.review?.base, "HEAD"));
  if (!baseRev) return { error: "Could not find the commit the guide's changes start from." };
  const current = (await g(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  return { gitRoot: repoRoot, baseRev, head: { kind: "fs", root: sidecar?.headRoot && existsSync(sidecar.headRoot) ? sidecar.headRoot : repoRoot }, moved: !!headSha && !!current && current !== headSha };
}

async function mergeBaseFor(runner: Runner, cwd: string, base: string | undefined, head: string): Promise<string | null> {
  for (const candidate of [base, base && !base.includes("/") ? `origin/${base}` : undefined, "origin/HEAD", "origin/main", "main"]) {
    if (!candidate) continue;
    const r = await runner("git", ["--no-pager", "merge-base", candidate, head], { cwd, timeoutMs: 30_000 });
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
