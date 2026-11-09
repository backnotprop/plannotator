/**
 * The prompt for a question about a guide. Three shapes:
 *
 * - `loaded`: the guide's own session was loaded (the agent remembers the
 *   change and the guide), so the prompt is the question and what it is about.
 * - `fresh`: a new session, seeded with the guide (title, intent, chapters),
 *   where the change is, what the question is about and its diff.
 * - `next`: another question in the same conversation, about other code.
 * - `followUp`: a follow-up to the last answer, about the same code.
 *
 * Each ends with how to answer (`show_answer`). No `vscode` here.
 */

import { parseDiffToFiles } from "@plannotator/core/diff-files";
import { ANSWER_GUIDE } from "./answer-tool";
import type { AskAbout } from "./answers";

/** The most diff text a prompt carries (a chapter's files together). */
const MAX_DIFF_CHARS = 60_000;

export interface AskGuideContext {
  title: string;
  intent: string;
  chapters: Array<{ title: string; overview: string; files: string[] }>;
  /** "PR #482, “Retry failed deliveries” (https://…)" or "the local changes on feat/x". */
  changeLabel: string;
  /** Where the head files are (the agent's working directory). */
  cwd: string;
  /** The commit the base side is read from. */
  baseRev: string;
  rawPatch: string;
}

export interface AskPromptInput {
  mode: "loaded" | "fresh" | "next" | "followUp";
  /** For `loaded`: whether the session wrote the guide, or answered earlier questions about it. */
  loadedFrom?: "guide" | "asks";
  question: string;
  about: AskAbout;
  guide: AskGuideContext;
  /** For a follow-up: the previous answer's question and title. */
  previous?: { question: string; title?: string };
}

/** One file's part of a patch, or null when the patch does not change it. */
export function fileDiff(rawPatch: string, path: string): string | null {
  const f = parseDiffToFiles(rawPatch).find((x) => x.path === path || x.oldPath === path);
  return f ? f.patch : null;
}

function capped(text: string, max = MAX_DIFF_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (cut; read the rest with git diff)` : text;
}

function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text.replace(/\n$/, "")}\n${ticks}`;
}

/** "lines 25–31 of src/x.ts (the new version)", "src/x.ts", "chapter 2". */
export function aboutLabel(about: AskAbout): string {
  const ch = `chapter ${about.chapter + 1}, “${about.chapterTitle}”`;
  if (about.kind === "chapter") return ch;
  const side = about.side === "base" ? " (the old version)" : " (the new version)";
  if (about.kind === "selection" && about.lines) {
    const lines = about.lines.start === about.lines.end ? `line ${about.lines.start}` : `lines ${about.lines.start}–${about.lines.end}`;
    // On the old side of a renamed file the lines are the old path's: name it, and the new one.
    const where = about.side === "base" && about.oldPath ? `${about.oldPath} (renamed to ${about.path} by the change)` : about.path;
    return `${lines} of ${where}${side}, in ${ch}`;
  }
  return `the file ${about.path}, in ${ch}`;
}

function numbered(code: string, start: number): string {
  return code.split("\n").map((line, i) => `${start + i} | ${line}`).join("\n");
}

function aboutBlock(about: AskAbout, guide: AskGuideContext): string {
  const parts = [`What the question is about: ${aboutLabel(about)}.`];
  if (about.kind === "selection" && about.code) parts.push(fence(numbered(about.code, about.lines?.start ?? 1)));
  if (about.kind === "chapter") {
    const ch = guide.chapters[about.chapter];
    if (ch) {
      parts.push(`The chapter's overview, as the guide tells it:\n${ch.overview}`);
      const diffs = ch.files.map((p) => fileDiff(guide.rawPatch, p)).filter((d): d is string => !!d);
      if (diffs.length) parts.push(`The chapter's files (${ch.files.join(", ")}), as the change has them:\n${fence(capped(diffs.join("\n")), "diff")}`);
    }
  } else if (about.path) {
    const diff = fileDiff(guide.rawPatch, about.path);
    if (diff) parts.push(`The file's diff:\n${fence(capped(diff), "diff")}`);
  }
  return parts.join("\n\n");
}

function guideBlock(guide: AskGuideContext): string {
  const chapters = guide.chapters.map((c, i) => `${i + 1}. ${c.title} (${c.files.join(", ") || "no files"})`).join("\n");
  return [`The guide (for orientation; the code is the truth):`, `Title: ${guide.title}`, `Intent: ${guide.intent}`, `Chapters:\n${chapters}`].join("\n");
}

function whereBlock(guide: AskGuideContext): string {
  return `The change: ${guide.changeLabel}. Its files are in your working directory (${guide.cwd}). To see the whole change: \`git diff ${guide.baseRev.slice(0, 12)}\`, plus untracked files (\`git status\`).`;
}

const HOW = (text: string) =>
  `How to answer:\n${text}\n\nRead what you need with your own tools. This is a review: do not edit, create or delete any file.`;

export function buildAskPrompt(input: AskPromptInput): string {
  const { guide, about } = input;
  const previous = input.previous && input.mode !== "followUp" ? `It follows their earlier question “${input.previous.question}”${input.previous.title ? ` (answered with “${input.previous.title}”)` : ""}.\n` : "";
  const question = `${previous}The question: ${input.question.trim()}`;
  if (input.mode === "followUp") {
    const prev = input.previous ? ` (after “${input.previous.question}”${input.previous.title ? `, which you answered with “${input.previous.title}”` : ""})` : "";
    return [
      `The reviewer asks a follow-up question${prev}. It is still about ${aboutLabel(about)}.`,
      question,
      HOW(ANSWER_GUIDE),
    ].join("\n\n");
  }
  if (input.mode === "next") {
    return [`The reviewer asks another question about this change.`, aboutBlock(about, guide), question, HOW(ANSWER_GUIDE)].join("\n\n");
  }
  if (input.mode === "loaded") {
    const intro = input.loadedFrom === "asks"
      ? `Earlier in this session you answered the reviewer's questions about a guided review of this change (“${guide.title}”). They ask another one.`
      : `Earlier in this session you wrote a guided review of this change (“${guide.title}”). The reviewer is reading it now, in VS Code, and asks you a question about it.`;
    return [
      intro,
      whereBlock(guide),
      aboutBlock(about, guide),
      question,
      HOW(ANSWER_GUIDE),
    ].join("\n\n");
  }
  return [
    "A reviewer is reading a guided review of a change in VS Code and asks you a question about it. Answer it.",
    whereBlock(guide),
    guideBlock(guide),
    aboutBlock(about, guide),
    question,
    HOW(ANSWER_GUIDE),
  ].join("\n\n");
}
