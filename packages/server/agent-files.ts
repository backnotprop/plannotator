import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const AGENT_FILE_MAX_BYTES = 1024 * 1024;

export type AgentFileRead =
  | { kind: "missing"; path: string; target: string }
  | { kind: "file"; path: string; target: string; text: string; mode: number; crlf: boolean; bom: boolean; linked: boolean }
  | { kind: "refused"; path: string; target: string; reason: string; tooBig?: true };

export function resolveAgentFileTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        const link = readlinkSync(path);
        return isAbsolute(link) ? link : resolve(dirname(path), link);
      }
    } catch {
    }
    return path;
  }
}

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
  if (stat.size > maxBytes) return { kind: "refused", path, target, reason: `it is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB`, tooBig: true };
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
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { kind: "file", path, target, text, mode: stat.mode & 0o777, crlf: dominantCrlf(text), bom, linked };
}

export function agentFileContains(path: string, needle: string, above: number): "small" | "absent" | "present" | { refused: string } {
  const target = resolveAgentFileTarget(path);
  let size: number;
  try {
    const stat = statSync(target);
    if (!stat.isFile()) return "small";
    size = stat.size;
  } catch {
    return "small";
  }
  if (size <= above) return "small";
  const pattern = Buffer.from(needle, "utf8");
  const chunk = Buffer.alloc(1024 * 1024 + pattern.length);
  let fd: number;
  try {
    fd = openSync(target, "r");
  } catch (error) {
    return { refused: describeFsError(error) };
  }
  try {
    let carried = 0;
    for (;;) {
      const read = readSync(fd, chunk, carried, chunk.length - carried, null);
      if (read === 0) return "absent";
      const filled = carried + read;
      if (chunk.subarray(0, filled).includes(pattern)) return "present";
      carried = Math.min(pattern.length - 1, filled);
      chunk.copy(chunk, 0, filled - carried, filled);
    }
  } catch (error) {
    return { refused: describeFsError(error) };
  } finally {
    closeSync(fd);
  }
}

export function dominantCrlf(text: string): boolean {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf;
}

export function withBom(text: string, bom: boolean): string {
  return bom ? `﻿${text}` : text;
}

export function withLineEndings(text: string, crlf: boolean): string {
  const lf = text.replace(/\r\n/g, "\n");
  return crlf ? lf.replace(/\n/g, "\r\n") : lf;
}

export function writeAgentFileAtomic(target: string, text: string, mode: number, mkdirParents = true, fsync = false): void {
  const dir = dirname(target);
  if (mkdirParents) mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.plannotator.tmp`);
  try {
    if (fsync) writeAndFlush(temp, text, mode);
    else writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function writeAndFlush(path: string, text: string, mode: number): void {
  const fd = openSync(path, "w", mode);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

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

export function samePlace(a: string, b: string): boolean {
  return a === b || placeKey(a) === placeKey(b);
}

export function describeFsError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "EROFS") return "it is on a read-only disk";
  if (code === "ENOSPC") return "the disk is full";
  if (code === "EISDIR") return "it is a folder";
  if (code === "ENOTDIR") return "a folder on its path is a file";
  if (code === "ELOOP") return "it is a link that leads back to itself";
  return error instanceof Error ? error.message : String(error);
}

export function jsonIndentOf(text: string): string | number {
  const match = /\n([ \t]+)["}\]]/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) return 2;
  return match[1]!.includes("\t") ? "\t" : match[1]!.length;
}

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
