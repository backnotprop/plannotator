/**
 * A file an agent fetched from the person's Inbox, saved on the agent's machine: a plain name in its folder (never a
 * path out of it), and a new file that never overwrites an earlier fetch. Shared by `plannotator inbox call
 * fetch_file` for a paired agent (apps/hook/server/inbox-call-fetch.ts) and the Inbox saving a linked machine's file
 * for an agent on this computer (packages/server/inbox-machine-agent-read.ts).
 */

import { open, type FileHandle } from "node:fs/promises";
import { extname, join } from "node:path";

/** The longest name saved, in bytes: under every file system's 255, with room for `-2`. */
const SAVED_NAME_MAX_BYTES = 200;

/** Cut to at most `max` UTF-8 bytes, never inside a character. */
function cutBytes(text: string, max: number): string {
  let out = "";
  for (const char of text) {
    if (Buffer.byteLength(out + char) > max) break;
    out += char;
  }
  return out;
}

/** The file's name as a plain name in the folder: never a path out of it, never a control character, never too long. */
export function savedFileName(name: string): string {
  const plain = name.replace(/[\\/\x00-\x1f\x7f]/g, "_").trim();
  if (plain === "" || /^\.+$/.test(plain)) return "file";
  if (Buffer.byteLength(plain) <= SAVED_NAME_MAX_BYTES) return plain;
  const ext = extname(plain);
  const keep = Buffer.byteLength(ext) <= 20 ? ext : "";
  return `${cutBytes(plain.slice(0, plain.length - keep.length), SAVED_NAME_MAX_BYTES - Buffer.byteLength(keep))}${keep}`;
}

/** A new file in `dir` named `name`, or `name-2`, `name-3`… when that one is taken: an earlier fetch is never overwritten. */
export async function newSavedFile(dir: string, name: string): Promise<{ path: string; handle: FileHandle }> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
    try {
      return { path, handle: await open(path, "wx", 0o600) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n >= 1000) throw error;
    }
  }
}
