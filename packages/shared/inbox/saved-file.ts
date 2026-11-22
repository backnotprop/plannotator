/**
 * A file an agent fetched from the person's Inbox, saved on the agent's machine: a plain name in its folder (never a
 * path out of it), and a new file that never overwrites an earlier fetch. Shared by `plannotator inbox call
 * fetch_file` for a paired agent (apps/hook/server/inbox-call-fetch.ts) and for a linked machine's file
 * (apps/hook/server/inbox-call-far-fetch.ts). Both save inside the command's own process, never the Inbox's.
 *
 * Also what a linked machine's file carries from that machine's door to this computer's Inbox, and from the Inbox to
 * the command (packages/server/inbox-machine-agent-read.ts): its name, SHA-256 and length in headers, and the words
 * for what can go wrong on the way.
 */

import { isDotenvFileName } from "@plannotator/core/annotatable";
import { INBOX_UPLOAD_MAX_BYTES } from "@plannotator/core/inbox-types";
import { open, type FileHandle } from "node:fs/promises";
import { extname, join } from "node:path";

/** The headers a fetched file's name (URI-encoded), SHA-256, length and machine ride in; its type in `Content-Type`. */
export const FETCHED_FILE_NAME_HEADER = "X-Plannotator-File-Name";
export const FETCHED_FILE_SHA_HEADER = "X-Plannotator-File-Sha256";
export const FETCHED_FILE_SIZE_HEADER = "X-Plannotator-File-Size";
export const FETCHED_FILE_MACHINE_HEADER = "X-Plannotator-File-Machine";

/** The most an agent fetches, in bytes: the upload cap. */
export const FETCHED_FILE_MAX_BYTES = INBOX_UPLOAD_MAX_BYTES;
const MB = 1024 * 1024;

/** Words for a fetched file that did not arrive whole. Approved lines: `stopped`, `tooLarge`. */
export const FETCHED_FILE_WORDS = {
  stopped: (name: string) => `The other computer stopped sending ${name}. Nothing was saved; fetch it again.`,
  tooLarge: (name: string, bytes: number) => `${name} is ${Math.ceil(bytes / MB)} MB; an agent fetches a file of at most ${FETCHED_FILE_MAX_BYTES / MB} MB.`,
  over: (name: string) => `${name} is over ${FETCHED_FILE_MAX_BYTES / MB} MB; an agent fetches a file of at most ${FETCHED_FILE_MAX_BYTES / MB} MB.`,
  dotenv: (name: string) => `${name}: the Inbox does not hand out a .env file.`,
  mismatch: (name: string, size: number, sha256: string) => `${name} arrived as ${size} bytes with SHA-256 ${sha256}, not as the other computer named it. Nothing was saved; fetch it again.`,
} as const;

/** A fetched file's name as its header carries it (ASCII only, so no name can add a header or a line). */
export const fetchedNameHeader = (name: string): string => encodeURIComponent(name.slice(0, 1024));

/** The name a header carries, or "file" when it does not decode. */
export function fetchedNameOf(header: string | null): string {
  try {
    return decodeURIComponent(header ?? "").slice(0, 1024) || "file";
  } catch {
    return "file";
  }
}

/** A SHA-256 as its header carries it: 64 lowercase hex digits, or null. */
export const fetchedShaOf = (header: string | null): string | null => {
  const sha = (header ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(sha) ? sha : null;
};

/** A length as its header carries it: a whole number of bytes, or null. */
export const fetchedSizeOf = (header: string | null): number | null => (header !== null && /^\d{1,15}$/.test(header.trim()) ? Number(header.trim()) : null);

/** A content type that is one (type/subtype and plain parameters), or `application/octet-stream`. */
export function fetchedTypeOf(header: string | null): string {
  const type = (header ?? "").trim();
  const token = "[A-Za-z0-9!#$&^_.+-]+";
  const ok = type.length <= 200 && new RegExp(`^${token}/${token}(\\s*;\\s*${token}=(${token}|"[^"\\x00-\\x1f\\x7f]*"))*$`).test(type);
  return ok ? type : "application/octet-stream";
}

/**
 * Whether a fetched file would be saved under a dotenv name: the name it is saved as (`savedFileName` trims it), and
 * that name without the trailing dots and spaces Windows drops (`x.env.` is saved there as `x.env`).
 */
export function savedNameIsDotenv(name: string): boolean {
  const saved = savedFileName(name);
  return isDotenvFileName(saved) || isDotenvFileName(saved.replace(/[. ]+$/, ""));
}

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
