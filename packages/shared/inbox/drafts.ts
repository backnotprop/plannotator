/**
 * Plannotator Inbox: drafts of a message the person starts (compose).
 *
 *   inbox/drafts/<drf_id>.json   one draft, 0600, written whole (temp, then rename)
 *
 * Files, not the store's JSONL: a draft changes often, and it must never
 * enter the event log, which is what the window's stream, wait_for_reply's
 * cursor, the phone relay and search read. So a draft is invisible to agents,
 * phones and search by construction.
 *
 * A save is a compare-and-set on `updated_at`: `base` is the `updated_at` the
 * writer last read (null to create), and a draft another tab changed since is
 * `409 draft_conflict` with the newer draft, so two tabs never silently
 * overwrite each other. A draft never sends itself; sending one is the normal
 * `POST /api/inbox/messages` with its `draft_id`, which deletes it.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_CARD_TITLE_MAX, isInboxId, type InboxDraft, type InboxDraftTo, type InboxUpload } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { readInboxUpload } from "./uploads";

export const INBOX_DRAFTS_DIR = "drafts";
/** The longest thread name a draft keeps while the person types (a Send takes at most INBOX_THREAD_NAME_MAX). */
export const INBOX_DRAFT_THREAD_NAME_MAX = 500;

/** The longest draft body, in characters (the store takes any body, but a draft is saved on every pause). */
export const INBOX_DRAFT_BODY_MAX = 1_000_000;
const SHORT_MAX = 4096;

function draftsDir(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_DRAFTS_DIR);
}

function draftFile(inboxDirPath: string, id: string): string {
  return join(draftsDir(inboxDirPath), `${id}.json`);
}

function parseDraft(text: string): InboxDraft | null {
  try {
    const value = JSON.parse(text) as InboxDraft;
    if (!value || value.v !== 1 || !isInboxId("drf", value.id) || typeof value.updated_at !== "string" || typeof value.body !== "string") return null;
    return { ...value, files: Array.isArray(value.files) ? value.files : [] };
  } catch {
    return null;
  }
}

export function readInboxDraft(inboxDirPath: string, id: unknown): InboxDraft | null {
  if (!isInboxId("drf", id)) return null;
  try {
    return parseDraft(readFileSync(draftFile(inboxDirPath, id), "utf8"));
  } catch {
    return null;
  }
}

/** Every draft, the newest saved first. */
export function listInboxDrafts(inboxDirPath: string): InboxDraft[] {
  let names: string[];
  try {
    names = readdirSync(draftsDir(inboxDirPath));
  } catch {
    return [];
  }
  const out: InboxDraft[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const draft = readInboxDraft(inboxDirPath, name.slice(0, -5));
    if (draft) out.push(draft);
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
}

/** The bytes the drafts take (Settings' Storage). */
export function inboxDraftsBytes(inboxDirPath: string): number {
  let total = 0;
  try {
    for (const name of readdirSync(draftsDir(inboxDirPath))) {
      try {
        total += statSync(join(draftsDir(inboxDirPath), name)).size;
      } catch {
        // Gone between the listing and the stat.
      }
    }
  } catch {
    // No drafts yet.
  }
  return total;
}

/** The uploads every draft names: the upload sweep keeps them. */
export function inboxDraftUploadIds(inboxDirPath: string): Set<string> {
  return new Set(listInboxDrafts(inboxDirPath).flatMap((draft) => draft.files.map((file) => file.upload_id)));
}

const short = (value: unknown, field: string, nullable: boolean): string | null => {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new InboxError("validation_error", `${field}: required.`, { field });
  }
  if (typeof value !== "string" || value.length > SHORT_MAX) throw new InboxError("validation_error", `${field}: a string.`, { field });
  return value;
};

function checkTo(value: unknown): InboxDraftTo | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new InboxError("validation_error", "to: { host, session } or null.", { field: "to" });
  const to = value as Record<string, unknown>;
  const host = short(to.host, "to.host", false)!;
  const session = short(to.session, "to.session", false)!;
  if (!host || !session) throw new InboxError("validation_error", "to: { host, session } or null.", { field: "to" });
  return {
    host,
    session,
    project_root: short(to.project_root, "to.project_root", true),
    project_name: short(to.project_name, "to.project_name", true),
    started_at: short(to.started_at, "to.started_at", true),
  };
}

function checkProject(value: unknown): InboxDraft["project"] {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new InboxError("validation_error", "project: { id, root, name } or null.", { field: "project" });
  const project = value as Record<string, unknown>;
  const id = project.id === null || project.id === undefined ? null : isInboxId("prj", project.id) ? project.id : null;
  return { id, root: short(project.root, "project.root", false)!, name: short(project.name, "project.name", false)! };
}

/** The Board card a draft was started for (Create thread): `{ id: crd_…, title }`, or null. */
function checkCard(value: unknown): InboxDraft["card"] | null {
  if (value === null || value === undefined) return null;
  const card = value as Record<string, unknown>;
  if (typeof value !== "object" || Array.isArray(value) || !isInboxId("crd", card.id) || typeof card.title !== "string" || [...card.title].length > INBOX_CARD_TITLE_MAX) {
    throw new InboxError("validation_error", "card: { id: crd_…, title } or null.", { field: "card" });
  }
  return { id: card.id, title: card.title };
}

/**
 * Create or replace a draft. `input.files` are upload ids (or `{ upload_id }`),
 * each an upload still pending; the draft keeps the upload's facts.
 * `base` is the `updated_at` this writer read, or null to create one.
 */
export function saveInboxDraft(
  inboxDirPath: string,
  id: unknown,
  input: { body?: unknown; to?: unknown; project?: unknown; files?: unknown; base?: unknown; thread_name?: unknown; card?: unknown; board_request?: unknown },
  at: string,
): InboxDraft {
  if (!isInboxId("drf", id)) throw new InboxError("validation_error", "id: a draft id (drf_…).", { field: "id" });
  const body = input.body === undefined ? "" : input.body;
  if (typeof body !== "string" || body.length > INBOX_DRAFT_BODY_MAX) {
    throw new InboxError("validation_error", `body: a string of at most ${INBOX_DRAFT_BODY_MAX} characters.`, { field: "body" });
  }
  // The thread's name as the person is typing it: kept as typed (the Send checks it by the thread-name rules).
  const threadName = input.thread_name === undefined || input.thread_name === null ? "" : input.thread_name;
  if (typeof threadName !== "string" || threadName.length > INBOX_DRAFT_THREAD_NAME_MAX) {
    throw new InboxError("validation_error", `thread_name: a string of at most ${INBOX_DRAFT_THREAD_NAME_MAX} characters.`, { field: "thread_name" });
  }
  const files: InboxUpload[] = [];
  const listed = input.files === undefined || input.files === null ? [] : input.files;
  if (!Array.isArray(listed)) throw new InboxError("validation_error", "files: a list of upload ids.", { field: "files" });
  listed.forEach((entry, index) => {
    const uploadId = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { upload_id?: unknown }).upload_id : null;
    const upload = readInboxUpload(inboxDirPath, uploadId);
    if (!upload) throw new InboxError("upload_not_found", `files[${index}]: that file is no longer here; attach it again.`, { field: `files[${index}]` });
    if (!files.some((file) => file.upload_id === upload.upload_id)) files.push(upload);
  });
  const to = checkTo(input.to);
  const project = checkProject(input.project);
  const card = checkCard(input.card);
  const base = input.base === undefined ? null : input.base;
  if (base !== null && typeof base !== "string") throw new InboxError("validation_error", "base: the updated_at you read, or null to create.", { field: "base" });
  const existing = readInboxDraft(inboxDirPath, id);
  if ((existing?.updated_at ?? null) !== base) {
    throw new InboxError(
      "draft_conflict",
      existing ? "This draft changed in another window since you opened it." : "This draft was deleted in another window.",
      { draft: existing },
    );
  }
  // Strictly later than the last save, so a compare-and-set within one millisecond still tells the two apart.
  let updatedAt = at;
  if (existing && updatedAt <= existing.updated_at) updatedAt = new Date(Date.parse(existing.updated_at) + 1).toISOString();
  const draft: InboxDraft = {
    v: 1,
    id,
    created_at: existing?.created_at ?? at,
    updated_at: updatedAt,
    body,
    to,
    project,
    files,
    ...(threadName.trim() ? { thread_name: threadName } : {}),
    ...(card ? { card } : {}),
    // Compose's Board chip, kept as it was left (approval "inbox-compose-board-chip").
    ...(input.board_request === true ? { board_request: true as const } : {}),
  };
  const dir = draftsDir(inboxDirPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = draftFile(inboxDirPath, id);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(draft)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return draft;
}

/** Delete a draft; true when there was one. */
export function deleteInboxDraft(inboxDirPath: string, id: unknown): boolean {
  if (!isInboxId("drf", id)) return false;
  try {
    unlinkSync(draftFile(inboxDirPath, id));
    return true;
  } catch {
    return false;
  }
}
