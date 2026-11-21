import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_COMMENT_PICTURES_MAX, INBOX_MESSAGE_COMMENT_TEXT_MAX, inboxCommentPicture, isInboxId } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { readInboxUpload } from "./uploads";

export interface InboxCommentDraftImage {
  path: string;
  name: string;
  kind?: "file";
}

export interface InboxCommentDraft {
  v: 1;
  thread_id: string;
  key: string;
  text: string;
  images: InboxCommentDraftImage[];
  updated_at: string;
}

export type InboxCommentDraftSave = { draft: InboxCommentDraft | null } | { conflict: InboxCommentDraft | null };

const DIR = "comment-drafts";
const KEY_MAX = 600;

function folder(inboxDir: string): string {
  return join(inboxDir, DIR);
}

function fileOf(inboxDir: string, threadId: string, key: string): string {
  return join(folder(inboxDir), `${threadId}-${createHash("sha256").update(key).digest("hex").slice(0, 40)}.json`);
}

function parse(text: string): InboxCommentDraft | null {
  try {
    const value = JSON.parse(text) as InboxCommentDraft;
    if (value?.v !== 1 || !isInboxId("msg", value.thread_id) || typeof value.key !== "string") return null;
    if (typeof value.text !== "string" || typeof value.updated_at !== "string" || !Array.isArray(value.images)) return null;
    return value;
  } catch {
    return null;
  }
}

function checkKey(threadId: string, key: unknown): string {
  if (!isInboxId("msg", threadId)) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
  if (typeof key !== "string" || key === "" || key.length > KEY_MAX) throw new InboxError("validation_error", `key: the comment box's key (1 to ${KEY_MAX} characters).`, { field: "key" });
  return key;
}

function checkImages(inboxDir: string, images: unknown): InboxCommentDraftImage[] {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images) || images.length > INBOX_COMMENT_PICTURES_MAX) {
    throw new InboxError("validation_error", `images: at most ${INBOX_COMMENT_PICTURES_MAX}, each { path, name }.`, { field: "images" });
  }
  return images.flatMap((image) => {
    const { path, name, kind } = (image && typeof image === "object" ? image : {}) as Record<string, unknown>;
    const upload = inboxCommentPicture(path);
    if (!upload || typeof name !== "string" || name.length > 200) throw new InboxError("validation_error", "images: each { path: \"<upload id>/<file name>\", name } of a file you uploaded.", { field: "images" });
    if (!readInboxUpload(inboxDir, upload.upload_id)) return [];
    return [{ path: path as string, name, ...(kind === "file" ? { kind: "file" as const } : {}) }];
  });
}

export function readInboxCommentDraft(inboxDir: string, threadId: string, key: unknown): InboxCommentDraft | null {
  const checked = checkKey(threadId, key);
  try {
    const draft = parse(readFileSync(fileOf(inboxDir, threadId, checked), "utf8"));
    return draft && draft.thread_id === threadId && draft.key === checked ? draft : null;
  } catch {
    return null;
  }
}

function remove(inboxDir: string, threadId: string, key: string): boolean {
  try {
    unlinkSync(fileOf(inboxDir, threadId, key));
    return true;
  } catch {
    return false;
  }
}

export function saveInboxCommentDraft(inboxDir: string, threadId: string, input: Record<string, unknown>, now = new Date()): InboxCommentDraftSave {
  const key = checkKey(threadId, input.key);
  const existing = readInboxCommentDraft(inboxDir, threadId, key);
  const base = typeof input.base === "string" ? input.base : null;
  if ((existing?.updated_at ?? null) !== base && input.force !== true) return { conflict: existing };
  const text = input.text;
  if (typeof text !== "string" || text.length > INBOX_MESSAGE_COMMENT_TEXT_MAX) {
    throw new InboxError("validation_error", `text: at most ${INBOX_MESSAGE_COMMENT_TEXT_MAX} characters.`, { field: "text" });
  }
  const images = checkImages(inboxDir, input.images);
  if (text.trim() === "" && images.length === 0) {
    remove(inboxDir, threadId, key);
    return { draft: null };
  }
  const stamp = now.toISOString();
  const updated_at = existing && stamp <= existing.updated_at ? new Date(Date.parse(existing.updated_at) + 1).toISOString() : stamp;
  const draft: InboxCommentDraft = { v: 1, thread_id: threadId, key, text, images, updated_at };
  mkdirSync(folder(inboxDir), { recursive: true, mode: 0o700 });
  const file = fileOf(inboxDir, threadId, key);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(draft)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return { draft };
}

export function deleteInboxCommentDraft(inboxDir: string, threadId: string, key: unknown, base?: unknown): boolean {
  const checked = checkKey(threadId, key);
  if (typeof base === "string" && readInboxCommentDraft(inboxDir, threadId, checked)?.updated_at !== base) return false;
  return remove(inboxDir, threadId, checked);
}

export function inboxCommentDraftUploadIds(inboxDir: string, threadExists: (threadId: string) => boolean): Set<string> {
  const keep = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(folder(inboxDir)).filter((name) => name.endsWith(".json"));
  } catch {
    return keep;
  }
  for (const name of names) {
    const path = join(folder(inboxDir), name);
    let draft: InboxCommentDraft | null = null;
    try {
      draft = parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!draft) continue;
    if (!threadExists(draft.thread_id)) {
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    for (const image of draft.images) {
      const upload = inboxCommentPicture(image.path);
      if (upload) keep.add(upload.upload_id);
    }
  }
  return keep;
}
