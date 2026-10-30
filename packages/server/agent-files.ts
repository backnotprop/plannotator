/**
 * Careful reads and writes of files that belong to the person's agents
 * (`~/.cursor/mcp.json`, `~/.codex/AGENTS.md`, …), for the Inbox's agent
 * connections (inbox-agents.ts) and notes (inbox-agent-notes.ts).
 *
 * The rules (the approved design, "Safety"):
 *  - A symlink (a dotfiles repo) is read and written at its target.
 *  - Anything that is not a regular file once resolved, is over 1 MiB, or is
 *    not UTF-8 is refused: nothing is written.
 *  - A write goes to a temp file in the same folder, then a rename, keeping
 *    the file's mode. Line endings are the caller's: `withLineEndings` puts
 *    the file's own back (CRLF stays CRLF).
 *  - A write whose result equals the file is skipped, so its mtime does not
 *    change (Codex and OpenCode 2 re-send an instruction file that changed
 *    into every open session).
 *
 * Bun-only callers, node:fs only.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Files larger than this are never edited. */
export const AGENT_FILE_MAX_BYTES = 1024 * 1024;

export type AgentFileRead =
  | { kind: "missing"; path: string; target: string }
  /**
   * `text` without its UTF-8 BOM (`bom` says it had one; put it back when
   * writing); `crlf`: CRLF is the file's dominant line ending (more CRLF than
   * lone LF), which new text takes.
   */
  | { kind: "file"; path: string; target: string; text: string; mode: number; crlf: boolean; bom: boolean; linked: boolean }
  | { kind: "refused"; path: string; target: string; reason: string };

/** Where `path` leads: its target when it is a symlink (followed as far as it exists), else itself. */
export function resolveAgentFileTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A dangling link names a target that does not exist yet: write there.
    try {
      if (lstatSync(path).isSymbolicLink()) {
        const link = readlinkSync(path);
        return isAbsolute(link) ? link : resolve(dirname(path), link);
      }
    } catch {
      // Missing: the path itself.
    }
    return path;
  }
}

/** Read an agent's file under the rules above. */
export function readAgentFile(path: string, maxBytes: number = AGENT_FILE_MAX_BYTES): AgentFileRead {
  const target = resolveAgentFileTarget(path);
  let linked = false;
  try {
    linked = lstatSync(path).isSymbolicLink();
  } catch {
    linked = false;
  }
  let stat;
  try {
    stat = statSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing", path, target };
    return { kind: "refused", path, target, reason: describeFsError(error) };
  }
  if (!stat.isFile()) return { kind: "refused", path, target, reason: "it is not a regular file" };
  if (stat.size > maxBytes) return { kind: "refused", path, target, reason: `it is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB` };
  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
  } catch (error) {
    return { kind: "refused", path, target, reason: describeFsError(error) };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "refused", path, target, reason: "it is not UTF-8 text" };
  }
  // TextDecoder drops a leading BOM; the bytes say whether there was one.
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { kind: "file", path, target, text, mode: stat.mode & 0o777, crlf: dominantCrlf(text), bom, linked };
}

/** More CRLF than lone LF line endings. */
export function dominantCrlf(text: string): boolean {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf;
}

/** `text` in a file that read as `read`: its BOM back. */
export function withBom(text: string, bom: boolean): string {
  return bom ? `﻿${text}` : text;
}

/** `text` with LF line endings turned into the file's own (CRLF stays CRLF). */
export function withLineEndings(text: string, crlf: boolean): string {
  const lf = text.replace(/\r\n/g, "\n");
  return crlf ? lf.replace(/\n/g, "\r\n") : lf;
}

/**
 * Write `text` to `target` atomically: a temp file beside it, then a rename,
 * keeping `mode`. Creates the folder when missing (`mkdirParents`).
 */
export function writeAgentFileAtomic(target: string, text: string, mode: number, mkdirParents = true): void {
  const dir = dirname(target);
  if (mkdirParents) mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.plannotator.tmp`);
  try {
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * A path as the file system names it, so one place spelled two ways is one
 * place: the real path of its deepest existing folder (a symlinked folder,
 * `/tmp` and `/private/tmp`, another case on a volume that ignores case: the
 * real path has the case on disk), the rest as written, normalized. Never
 * case-folded: on a case-sensitive volume (Linux, or one formatted so on
 * macOS) `qwen` and `Qwen` are two folders.
 */
export function placeKey(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      head = realpathSync.native(head);
      break;
    } catch {
      const parent = dirname(head);
      if (parent === head) break;
      rest.unshift(basename(head));
      head = parent;
    }
  }
  return join(head, ...rest);
}

/** Whether two paths name one place (`placeKey`). */
export function samePlace(a: string, b: string): boolean {
  return a === b || placeKey(a) === placeKey(b);
}

/** A short, plain reason for a file-system error. */
export function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "EROFS") return "it is on a read-only disk";
  if (code === "ENOSPC") return "the disk is full";
  if (code === "EISDIR") return "it is a folder";
  if (code === "ENOTDIR") return "a folder on its path is a file";
  return error instanceof Error ? error.message : String(error);
}

/** The indentation a JSON file uses (its first indented line), two spaces by default. */
export function jsonIndentOf(text: string): string | number {
  const match = /\n([ \t]+)["}\]]/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) return 2;
  return match[1]!.includes("\t") ? "\t" : match[1]!.length;
}

/**
 * JSON with comments and trailing commas (Gemini's settings, OpenCode's
 * opencode.jsonc, Amp's settings) turned into plain JSON, for READING only:
 * Plannotator never writes such a file itself (the agent's own `mcp add`
 * does). Strings are kept as they are.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
