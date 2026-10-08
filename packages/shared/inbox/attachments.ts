/**
 * Plannotator Inbox attachments on disk: recording a file at send time, the
 * content-addressed blobs, and reading a file again by its record.
 *
 *   inbox/blobs/<sha256>    the bytes of a sent version, written once
 *
 * The rules (see packages/core/inbox-attachments.ts): a file is recorded by
 * its realpath and must sit inside the sending project; annotate's file rules
 * apply without its size bound; a file is only ever read again through its
 * record, never through a path a request names. When the current file is
 * read, the recorded realpath must still be that same regular file: a path
 * component that became a symlink, a file that became a directory, or a
 * symlink the agent attached that now points elsewhere is refused (the sent
 * version still opens from its blob).
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import {
  inboxAttachmentId,
  inboxAttachmentKind,
  inboxAttachmentNameRefusal,
  type InboxAttachment,
  type InboxAttachmentState,
  type InboxAttachmentUnavailable,
} from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export const BLOBS_DIR = "blobs";

const SHA256_RE = /^[0-9a-f]{64}$/;

export function inboxBlobsDir(inboxDirPath: string): string {
  return join(inboxDirPath, BLOBS_DIR);
}

export function inboxBlobPath(inboxDirPath: string, sha256: string): string {
  if (!SHA256_RE.test(sha256)) throw new InboxError("validation_error", "Not a blob hash.");
  return join(inboxBlobsDir(inboxDirPath), sha256);
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Write a blob once (temp file, then rename), owner-only. Also the guided reviews' writer (step 5, packages/server/inbox-guides.ts). */
export function writeBlob(inboxDirPath: string, sha256: string, bytes: Uint8Array): void {
  const dir = inboxBlobsDir(inboxDirPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = inboxBlobPath(inboxDirPath, sha256);
  if (existsSync(path)) return;
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, bytes, { mode: 0o600 });
  renameSync(temp, path);
}

/**
 * Record the files an agent attached: each path absolute or relative to
 * `base` (the agent's project_path), resolved to its realpath, inside
 * `projectRoot`, a regular file passing annotate's name rules. Every file is
 * checked before any blob is written; one refusal refuses the whole send.
 */
export function recordInboxAttachments(
  inboxDirPath: string,
  paths: readonly unknown[],
  options: { base: string; projectRoot: string; at: string },
): InboxAttachment[] {
  const read: { named: string; real: string; bytes: Buffer; mtime: string }[] = [];
  paths.forEach((value, index) => {
    const field = `attachments[${index}]`;
    const refuse = (message: string): never => {
      throw new InboxError("validation_error", `${field}: ${message}`, { field });
    };
    if (typeof value !== "string" || value.trim() === "") refuse("a file path is required.");
    const named = isAbsolute(value as string) ? resolve(value as string) : resolve(options.base, value as string);
    const nameRefusal = inboxAttachmentNameRefusal(named);
    if (nameRefusal) refuse(`${basename(named)}: ${nameRefusal}`);
    let real: string;
    try {
      real = realpathSync(named);
    } catch {
      return refuse(`${named}: no such file.`);
    }
    const realRefusal = inboxAttachmentNameRefusal(real);
    if (realRefusal) refuse(`${basename(named)} resolves to ${basename(real)}: ${realRefusal}`);
    if (!isInside(real, options.projectRoot)) refuse(`${named}: outside the project (${options.projectRoot}).`);
    let stat;
    try {
      stat = statSync(real);
    } catch {
      return refuse(`${named}: no such file.`);
    }
    if (!stat.isFile()) refuse(`${named}: not a regular file.`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(real);
    } catch {
      return refuse(`${named}: could not be read.`);
    }
    read.push({ named, real, bytes, mtime: stat.mtime.toISOString() });
  });
  return read.map(({ named, real, bytes, mtime }) => {
    const sha256 = sha256Of(bytes);
    writeBlob(inboxDirPath, sha256, bytes);
    return {
      id: inboxAttachmentId(),
      path: real,
      named_path: named === real ? null : named,
      name: basename(real),
      kind: inboxAttachmentKind(real),
      sent_sha256: sha256,
      size: bytes.length,
      sent_at: options.at,
      sent_mtime: mtime,
    } satisfies InboxAttachment;
  });
}

export type InboxAttachmentRead =
  | { ok: true; bytes: Buffer; sha256: string; size: number; mtime: string }
  | { ok: false; unavailable: InboxAttachmentUnavailable };

/** The current file, read only through its record (the rules in the header). */
export function readInboxAttachmentCurrent(attachment: InboxAttachment): InboxAttachmentRead {
  const missing = (message: string): InboxAttachmentRead => ({ ok: false, unavailable: { code: "attachment_missing", message } });
  const changed = (message: string): InboxAttachmentRead => ({ ok: false, unavailable: { code: "attachment_changed_type", message } });
  let real: string;
  try {
    real = realpathSync(attachment.path);
  } catch {
    return missing(`${attachment.name} is no longer on disk.`);
  }
  if (real !== attachment.path) return changed(`${attachment.path} now leads somewhere else (${real}).`);
  if (attachment.named_path) {
    let target: string;
    try {
      target = realpathSync(attachment.named_path);
    } catch {
      return missing(`${attachment.named_path} is no longer on disk.`);
    }
    if (target !== attachment.path) return changed(`${attachment.named_path} now points somewhere else (${target}).`);
  }
  let stat;
  try {
    stat = lstatSync(attachment.path);
  } catch {
    return missing(`${attachment.name} is no longer on disk.`);
  }
  if (!stat.isFile()) return changed(`${attachment.path} is no longer a regular file.`);
  const refusal = inboxAttachmentNameRefusal(attachment.path);
  if (refusal) return changed(refusal);
  let bytes: Buffer;
  try {
    bytes = readFileSync(attachment.path);
  } catch {
    return missing(`${attachment.name} could not be read.`);
  }
  return { ok: true, bytes, sha256: sha256Of(bytes), size: bytes.length, mtime: stat.mtime.toISOString() };
}

/** The sent version's bytes, or null when its blob is gone. */
export function readInboxAttachmentSent(inboxDirPath: string, attachment: InboxAttachment): Buffer | null {
  try {
    return readFileSync(inboxBlobPath(inboxDirPath, attachment.sent_sha256));
  } catch {
    return null;
  }
}

/** The record plus the file as it is now. */
export function inboxAttachmentState(attachment: InboxAttachment, messageId: string): InboxAttachmentState {
  const current = readInboxAttachmentCurrent(attachment);
  return {
    ...attachment,
    message_id: messageId,
    current: current.ok ? { sha256: current.sha256, size: current.size, mtime: current.mtime } : null,
    changed_since_sent: current.ok && current.sha256 !== attachment.sent_sha256,
    unavailable: current.ok ? null : current.unavailable,
  };
}

/** Each blob's size on disk, by hash. */
export function inboxBlobSizes(inboxDirPath: string): Map<string, number> {
  const sizes = new Map<string, number>();
  const dir = inboxBlobsDir(inboxDirPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return sizes;
  }
  for (const name of names) {
    if (!SHA256_RE.test(name)) continue;
    try {
      sizes.set(name, statSync(join(dir, name)).size);
    } catch {
      // Gone between the listing and the stat.
    }
  }
  return sizes;
}

/** Remove every blob no record uses any more. */
export function removeUnusedInboxBlobs(inboxDirPath: string, used: ReadonlySet<string>): void {
  for (const sha256 of inboxBlobSizes(inboxDirPath).keys()) {
    if (used.has(sha256)) continue;
    try {
      unlinkSync(inboxBlobPath(inboxDirPath, sha256));
    } catch {
      // Already gone.
    }
  }
}
