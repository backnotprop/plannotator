/**
 * Plannotator Inbox: drafts of a message the person starts (compose).
 *
 *   inbox/drafts/<drf_id>.json   one draft, 0600, written whole (temp, then rename)
 *
 * Files, not the store's JSONL: a draft changes often, and it must never
 * enter the event log, which is what the window's stream, read_thread's
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
import { parseInboxGitUrl } from "@plannotator/core/inbox-git-url";
import {
  INBOX_CARD_TITLE_MAX,
  INBOX_DRAFT_BODY_MAX,
  INBOX_DRAFT_PASTED_LEAD_MAX,
  INBOX_DRAFT_PASTED_PREVIEW_MAX,
  isInboxId,
  type InboxDraft,
  type InboxDraftFile,
  type InboxDraftPasted,
  type InboxDraftTo,
} from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { readInboxUpload } from "./uploads";

export const INBOX_DRAFTS_DIR = "drafts";
/** The longest thread name a draft keeps while the person types (a Send takes at most INBOX_THREAD_NAME_MAX). */
export const INBOX_DRAFT_THREAD_NAME_MAX = 500;

/** The longest draft body, in characters (the store takes any body, but a draft is saved on every pause). Defined in core so the window can name it. */
export { INBOX_DRAFT_BODY_MAX };
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

/** The pull requests a draft was started for (Launch an agent): `{ keys, projects, ask_line }`, or null. */
function checkPulls(value: unknown): InboxDraft["pulls"] | null {
  if (value === null || value === undefined) return null;
  const pulls = value as Record<string, unknown>;
  const strings = (list: unknown, max: number) => Array.isArray(list) && list.length > 0 && list.length <= max && list.every((v) => typeof v === "string" && v.length > 0 && v.length <= 600);
  if (typeof value !== "object" || Array.isArray(value) || !strings(pulls.keys, 20) || !strings(pulls.projects, 50) || typeof pulls.ask_line !== "string" || pulls.ask_line.length > 2000) {
    throw new InboxError("validation_error", "pulls: { keys, projects, ask_line } or null.", { field: "pulls" });
  }
  return { keys: [...(pulls.keys as string[])], projects: [...(pulls.projects as string[])], ask_line: pulls.ask_line };
}

/** A draft's folder pick (`InboxDraft.start`): `{ agent, machine, folder: "~/…", name, create? }`, or null. */
function checkStart(value: unknown): InboxDraft["start"] | null {
  if (value === null || value === undefined) return null;
  const start = value as Record<string, unknown>;
  const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !text(start.agent, 64) ||
    !(start.machine === null || isInboxId("ibx", start.machine)) ||
    !text(start.folder, 4096) ||
    !(start.folder as string).startsWith("~/") ||
    !text(start.name, 255) ||
    !(start.create === undefined || start.create === true) ||
    !checkStartClone(start.clone)
  ) {
    throw new InboxError("validation_error", "start: { agent, machine, folder: \"~/…\", name, create?, clone?: { url, branch? } } or null.", { field: "start" });
  }
  const clone = start.clone as { url: string; branch?: string } | undefined;
  return {
    agent: start.agent as string,
    machine: start.machine as string | null,
    folder: start.folder as string,
    name: start.name as string,
    ...(start.create === true ? { create: true as const } : {}),
    ...(clone ? { clone: { url: clone.url, ...(clone.branch ? { branch: clone.branch } : {}) } } : {}),
  };
}

/** A draft's clone pick: a git URL the launch reads (checked again at Send), and a branch that can't read as an option. */
function checkStartClone(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const clone = value as Record<string, unknown>;
  const repo = typeof clone.url === "string" && clone.url.length <= 2048 ? parseInboxGitUrl(clone.url) : null;
  if (!repo || repo.kind !== "repo") return false;
  return clone.branch === undefined || (typeof clone.branch === "string" && clone.branch.length > 0 && clone.branch.length <= 255 && !clone.branch.startsWith("-") && !/[\s\x00-\x1f]/.test(clone.branch));
}

/** A long paste's place in a draft's words (`InboxDraftPasted`), checked; null when the file is not one. */
function checkPasted(value: unknown, index: number, bodyLength: number, list = "files"): InboxDraftPasted | null {
  if (value === undefined || value === null) return null;
  const pasted = value as Record<string, unknown>;
  const field = `${list}[${index}].pasted`;
  if (typeof value !== "object" || Array.isArray(value)) throw new InboxError("validation_error", `${field}: { at, lead?, preview } or null.`, { field });
  const at = pasted.at;
  if (typeof at !== "number" || !Number.isInteger(at) || at < 0 || at > bodyLength) {
    throw new InboxError("validation_error", `${field}.at: a place in the words (0 to ${bodyLength}).`, { field: `${field}.at` });
  }
  const lead = pasted.lead === undefined || pasted.lead === null ? "" : pasted.lead;
  if (typeof lead !== "string" || lead.length > INBOX_DRAFT_PASTED_LEAD_MAX || /\S/.test(lead)) {
    throw new InboxError("validation_error", `${field}.lead: at most ${INBOX_DRAFT_PASTED_LEAD_MAX} spaces or line breaks.`, { field: `${field}.lead` });
  }
  const preview = pasted.preview;
  if (typeof preview !== "string" || preview.length > INBOX_DRAFT_PASTED_PREVIEW_MAX) {
    throw new InboxError("validation_error", `${field}.preview: a string of at most ${INBOX_DRAFT_PASTED_PREVIEW_MAX} characters.`, { field: `${field}.preview` });
  }
  return { at, ...(lead ? { lead } : {}), preview };
}

/**
 * A draft's files: upload ids (or `{ upload_id, pasted? }`), each an upload
 * still pending; the draft keeps the upload's facts, and for a long paste where
 * it goes back in the words (`pasted`, approval "inbox-paste-attachment").
 * New message's drafts and reply drafts check their files alike.
 */
export function checkInboxDraftFiles(
  inboxDirPath: string,
  input: unknown,
  bodyLength: number,
  how: { list?: string; skipGone?: boolean } = {},
): InboxDraftFile[] {
  const list = how.list ?? "files";
  const files: InboxDraftFile[] = [];
  const listed = input === undefined || input === null ? [] : input;
  if (!Array.isArray(listed)) throw new InboxError("validation_error", `${list}: a list of upload ids.`, { field: list });
  listed.forEach((entry, index) => {
    const object = entry && typeof entry === "object" ? (entry as { upload_id?: unknown; pasted?: unknown }) : null;
    const uploadId = typeof entry === "string" ? entry : object ? object.upload_id : null;
    // An entry that names no upload at all is a malformed save, not a file gone since: refused even with `skipGone`.
    if (typeof uploadId !== "string") {
      throw new InboxError("validation_error", `${list}[${index}]: an upload id, or { upload_id, pasted }.`, { field: `${list}[${index}]` });
    }
    const pasted = checkPasted(object?.pasted, index, bodyLength, list);
    const upload = readInboxUpload(inboxDirPath, uploadId);
    if (!upload) {
      // `skipGone`: a file sent or swept since is simply not added (a reply draft's added files).
      if (how.skipGone) return;
      throw new InboxError("upload_not_found", `${list}[${index}]: that file is no longer here; attach it again.`, { field: `${list}[${index}]` });
    }
    if (!files.some((file) => file.upload_id === upload.upload_id)) files.push(pasted ? { ...upload, pasted } : upload);
  });
  return files;
}

/** Long pastes' places in the words: `{ upload_id, pasted }` each (a place for a file the draft does not hold is ignored). */
export function checkInboxDraftPlaces(input: unknown, bodyLength: number, list: string): { upload_id: string; pasted: InboxDraftPasted }[] {
  const listed = input === undefined || input === null ? [] : input;
  if (!Array.isArray(listed)) throw new InboxError("validation_error", `${list}: a list of { upload_id, pasted }.`, { field: list });
  return listed.map((entry, index) => {
    const object = entry && typeof entry === "object" ? (entry as { upload_id?: unknown; pasted?: unknown }) : null;
    const pasted = checkPasted(object?.pasted, index, bodyLength, list);
    if (!object || typeof object.upload_id !== "string" || !pasted) {
      throw new InboxError("validation_error", `${list}[${index}]: { upload_id, pasted }.`, { field: `${list}[${index}]` });
    }
    return { upload_id: object.upload_id, pasted };
  });
}

/** Upload ids, as strings (a reply draft's removed files). */
export function checkInboxDraftIds(input: unknown, list: string): string[] {
  const listed = input === undefined || input === null ? [] : input;
  if (!Array.isArray(listed) || listed.some((id) => typeof id !== "string")) {
    throw new InboxError("validation_error", `${list}: a list of upload ids.`, { field: list });
  }
  return listed as string[];
}

/**
 * Create or replace a draft. `input.files` are upload ids (or `{ upload_id, pasted? }`),
 * each an upload still pending; the draft keeps the upload's facts.
 * `base` is the `updated_at` this writer read, or null to create one.
 */
export function saveInboxDraft(
  inboxDirPath: string,
  id: unknown,
  input: { body?: unknown; to?: unknown; project?: unknown; files?: unknown; base?: unknown; thread_name?: unknown; card?: unknown; pulls?: unknown; board_request?: unknown; start?: unknown },
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
  const files = checkInboxDraftFiles(inboxDirPath, input.files, body.length);
  const to = checkTo(input.to);
  const project = checkProject(input.project);
  const card = checkCard(input.card);
  const pulls = checkPulls(input.pulls);
  const start = checkStart(input.start);
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
    ...(pulls ? { pulls } : {}),
    // Compose's Board chip, kept as it was left (approval "inbox-compose-board-chip").
    ...(input.board_request === true ? { board_request: true as const } : {}),
    ...(start ? { start } : {}),
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
