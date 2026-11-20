import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { INBOX_INLINE_MEDIA_MAX_BYTES } from "@plannotator/core/inbox-inline-media";
import { inboxStatEtag } from "./attachments";
import { inboxAudioServedType } from "./audio";
import { locateInboxMessageImage, stillSameFile, type InboxMessageImageInput } from "./message-images";
import { sniffInboxVideo } from "./video";

export type InboxMessageMediaOpen =
  | { ok: true; handle: FileHandle; size: number; contentType: string; etag: string; named: string }
  | { ok: false; status: number; code: string; error: string; notYet?: true };

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const HEAD_BYTES = 64 * 1024;

const refuse = (status: number, code: string, error: string): InboxMessageMediaOpen => ({ ok: false, status, code, error });

export async function openInboxMessageMedia(input: InboxMessageImageInput): Promise<InboxMessageMediaOpen> {
  const located = locateInboxMessageImage(input, "media");
  if (!located.ok) return located;
  let handle: FileHandle;
  try {
    handle = await open(located.real, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return refuse(409, "image_changed", "That file changed while it was read.");
    if (code === "ENOENT") return refuse(404, "image_missing", "That file could not be opened.");
    if (code === "EACCES" || code === "EPERM") return refuse(403, "image_unreadable", "Plannotator can't read that file.");
    return refuse(500, "image_read_failed", "That file could not be read.");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return await closed(handle, refuse(404, "image_missing", "That is not a file."));
    if (stat.size > INBOX_INLINE_MEDIA_MAX_BYTES) return await closed(handle, refuse(413, "image_too_large", "That file is larger than 2 GB."));
    const head = Buffer.alloc(Math.min(stat.size, HEAD_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const bytes = head.subarray(0, bytesRead);
    const contentType = sniffInboxVideo(bytes) ?? inboxAudioServedType(bytes);
    if (!contentType) return await closed(handle, refuse(415, "not_media", "That file is not a recognized sound or video."));
    if (!stillSameFile(located.real, stat)) return await closed(handle, refuse(409, "image_changed", "That file changed while it was read."));
    return { ok: true, handle, size: stat.size, contentType, etag: inboxStatEtag(stat), named: located.named };
  } catch {
    return closed(handle, refuse(500, "image_read_failed", "That file could not be read."));
  }
}

async function closed(handle: FileHandle, result: InboxMessageMediaOpen): Promise<InboxMessageMediaOpen> {
  await handle.close().catch(() => {});
  return result;
}
