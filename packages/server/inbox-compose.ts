/**
 * Plannotator Inbox: compose, "send a new message to a connected agent"
 * (approval record "inbox-compose-to-agent", 2026-10-14; not in this repo).
 *
 * The person starts a thread from the window, addressed to one LIVE agent
 * session in any project. Nothing is sent without a live session: the window
 * saves a draft instead. The window's routes (same origin and the page's
 * `serverSession`, as every window write; the owner's page over the tailnet
 * too; the phone's door carries sessions, messages, messages/:id/to and
 * uploads, never drafts):
 *
 *   GET  /api/inbox/sessions                 every live session, grouped by project;
 *                                            `?session=<id>` adds `session: { session, live }`
 *                                            (with the asker grace) for a thread's delivery line
 *   POST /api/inbox/messages                 `{ to, body, idempotency_key, uploads?, draft_id?, thread_name?, thread_name_auto?, board_request? }`:
 *                                            a new thread (409 `session_not_live`, nothing written)
 *   POST /api/inbox/messages/:id/to          `{ to }`: "Send to another session" for a message
 *                                            no session took yet (a live session of its project)
 *   GET  /api/inbox/drafts                   the drafts, each with its chip (`status`), and `replies`:
 *                                            open threads holding unsent work (reply drafts,
 *                                            picks, comments; inbox-reply-drafts.ts)
 *   POST /api/inbox/drafts/:id               create or replace one (compare-and-set on `base`)
 *   POST /api/inbox/drafts/:id/delete        delete one
 *   POST /api/inbox/uploads?name=&serverSession=   one file, the raw body streamed
 *
 * Drafts and pending uploads live in files under `inbox/` (drafts.ts,
 * uploads.ts), outside the event log, so agents, phones and search never see
 * them. Pending uploads no draft names are swept after a day (`sweep`).
 */

import { homedir } from "node:os";
import { basename } from "node:path";
import { inboxHasUnsent, inboxRowArchived } from "@plannotator/shared/inbox/list";
import type { InboxReplyDraftRow } from "@plannotator/core/inbox-types";
import type { InboxComposeProject, InboxComposeSession, InboxDraft, InboxDraftStatus, InboxProject } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { deleteInboxDraft, inboxDraftUploadIds, listInboxDrafts, saveInboxDraft } from "@plannotator/shared/inbox/drafts";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import {
  inboxUploadAttachments,
  INBOX_UPLOAD_MAX_BYTES,
  receiveInboxUpload,
  removeInboxAttachmentFiles,
  removeInboxUploads,
  sweepInboxUploads,
} from "@plannotator/shared/inbox/uploads";
import type { createInboxLiveSessions } from "./inbox-sessions";

/** How many characters of a reply draft the Drafts page shows. */
const INBOX_REPLY_PREVIEW_MAX = 160;

/** How often pending uploads are swept (each sweep drops those older than a day that no draft names). */
export const INBOX_UPLOAD_SWEEP_MS = 60 * 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString();

export function createInboxCompose(options: {
  store: InboxStore;
  serverSession: string;
  live: ReturnType<typeof createInboxLiveSessions>;
  /** A folder to its project (realpath, git toplevel), created on first use: send_message's resolver. */
  resolveProject: (path: string) => Promise<InboxProject>;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  now?: () => Date;
  /** Whether the person has the Board on: a Send's `board_request` is kept only then. Absent: off. */
  boardOn?: () => boolean;
}) {
  const { store, serverSession, live, json } = options;
  const boardOn = options.boardOn ?? (() => false);
  const now = options.now ?? (() => new Date());
  const staleTab = (body: Record<string, unknown>) =>
    checkServerSession(body, serverSession) === "mismatch" ? json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409) : null;

  /** Where a live session works: its root, else the project it last wrote in, else nowhere it can be listed. */
  const placeOf = (root: string | null, session: string, lastThreads: ReturnType<InboxStore["lastThreadsBySession"]>): string | null => {
    if (root !== null) return root;
    const wrote = lastThreads.get(session);
    return wrote ? (store.project(wrote.project_id)?.root ?? null) : null;
  };

  /** Every live session, grouped by project: the most recently active project first, and inside one the most recently active session first. */
  const sessionsModel = (): InboxComposeProject[] => {
    const lastThreads = store.lastThreadsBySession();
    const groups = new Map<string, { project: InboxComposeProject["project"]; sessions: (InboxComposeSession & { activity: number })[] }>();
    for (const entry of live.allLive()) {
      const root = placeOf(entry.root, entry.session, lastThreads);
      if (root === null) continue;
      let group = groups.get(root);
      if (!group) {
        const known = store.projectByRoot(root);
        group = { project: known ? { id: known.id, name: known.name, root } : { id: null, name: basename(root) || root, root }, sessions: [] };
        groups.set(root, group);
      }
      const last = lastThreads.get(entry.session);
      group.sessions.push({
        session: entry.session,
        host: entry.host,
        started_at: iso(entry.startedAt),
        last_seen_at: iso(entry.lastSeen),
        busy: entry.busy,
        idle_since: entry.idleSince === null ? null : iso(entry.idleSince),
        last_thread: last ? { id: last.id, subject: last.subject, at: last.at } : null,
        activity: Math.max(entry.startedAt, last ? Date.parse(last.at) : 0),
      });
    }
    const ordered = [...groups.values()].map((group) => ({
      project: group.project,
      sessions: group.sessions.sort((a, b) => b.activity - a.activity || a.session.localeCompare(b.session)),
    }));
    ordered.sort((a, b) => (b.sessions[0]?.activity ?? 0) - (a.sessions[0]?.activity ?? 0) || a.project.name.localeCompare(b.project.name));
    return ordered.map((group) => ({ project: group.project, sessions: group.sessions.map(({ activity: _activity, ...session }) => session) }));
  };

  const draftStatus = (draft: InboxDraft): InboxDraftStatus => (draft.to === null ? "none" : live.isSessionLive(draft.to.session) ? "live" : "ended");
  const withStatus = (draft: InboxDraft) => ({ ...draft, status: draftStatus(draft) });

  /** A new thread the person writes, addressed to one live session (compose's Send). */
  const startThread = async (body: Record<string, unknown>): Promise<Response> => {
    // A replayed Send answers the thread it wrote, whatever the session's state now.
    const replay = replayThread(body);
    if (replay) return json(replay);
    const uploads = checkSend(body);
    const target = live.composeTarget(body.to);
    if (!target) {
      throw new InboxError("session_not_live", "That session is not live any more: nothing was sent. Pick a live session, or save it as a draft.");
    }
    const root = placeOf(target.root, target.session, store.lastThreadsBySession());
    if (root === null) throw new InboxError("session_not_live", "That session has not said where it works yet; try again in a moment.");
    const project = target.root !== null ? await options.resolveProject(root) : store.projectByRoot(root);
    if (!project) throw new InboxError("project_not_found", "That session's project is gone.");
    return json(writeThread(body, uploads, { host: target.host, session: target.session }, project));
  };

  /**
   * The Send itself, once its target and project are known: the thread, its
   * files, the draft it came from. Shared with the ACP runner's "Start a new
   * Grok Build session" (inbox-acp-runner.ts), whose session is made first.
   */
  const writeThread = (body: Record<string, unknown>, uploads: unknown[], to: { host: string; session: string }, project: InboxProject) => {
    const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    const at = now().toISOString();
    const attachments = uploads.length > 0 ? inboxUploadAttachments(store.dir, uploads, at) : [];
    let result: ReturnType<InboxStore["startPersonThread"]>;
    try {
      result = store.startPersonThread({
        project_id: project.id,
        body: body.body,
        to,
        idempotency_key: key,
        attachments,
        thread_name: body.thread_name,
        thread_name_auto: body.thread_name_auto,
        // The Board chip (approval "inbox-compose-board-chip"): kept only while the Board is on, so an agent is
        // never asked for cards the Board would refuse (`board_off`).
        board_request: body.board_request === true && boardOn(),
      });
    } catch (error) {
      removeInboxAttachmentFiles(store.dir, attachments);
      throw error;
    }
    // Another Send with this key landed while this one waited on the project:
    // its message stands, and the files written for this one are not used.
    if (result.replayed) removeInboxAttachmentFiles(store.dir, attachments);
    // Sent: the uploads are attachments now, and the draft it came from is done.
    removeInboxUploads(store.dir, uploads.filter((id): id is string => typeof id === "string"));
    if (body.draft_id !== undefined) deleteInboxDraft(store.dir, body.draft_id);
    return {
      thread_id: result.message.thread_id,
      message: result.message,
      project: { id: project.id, name: project.name, root: project.root },
      replayed: result.replayed,
    };
  };

  /** A replayed Send (the same idempotency key): the thread it wrote, whatever its session's state now; null when the key is new. */
  const replayThread = (body: Record<string, unknown>) => {
    const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a Send.", { field: "idempotency_key" });
    const replay = store.personThreadByKey(key);
    if (!replay) return null;
    const result = store.startPersonThread({ project_id: replay.project_id, body: body.body, to: replay.to ?? null, idempotency_key: key, thread_name: body.thread_name, thread_name_auto: body.thread_name_auto });
    return { thread_id: result.message.thread_id, message: result.message, replayed: true };
  };

  /** The uploads a Send names, checked; the body checked to have words. */
  const checkSend = (body: Record<string, unknown>): unknown[] => {
    if (typeof body.body !== "string" || body.body.trim() === "") throw new InboxError("validation_error", "body: write a message.", { field: "body" });
    const uploads = body.uploads === undefined || body.uploads === null ? [] : body.uploads;
    if (!Array.isArray(uploads)) throw new InboxError("validation_error", "uploads: a list of upload ids.", { field: "uploads" });
    return uploads;
  };

  /** "Send to another session": a message no session took yet, to a live session of its thread's project. */
  const readdress = (messageId: string, body: Record<string, unknown>): Response => {
    const message = store.message(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    const target = live.replyTarget(message.thread_id, body.to);
    const next = store.readdressMessage(messageId, target);
    return json({ message: next, row: store.listRow(next.thread_id) });
  };

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;
    if (path === "/api/inbox/sessions") {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      const session = url.searchParams.get("session");
      return json({
        serverSession,
        home: homedir(),
        projects: sessionsModel(),
        ...(session ? { session: { session, live: live.askerLive(session) } } : {}),
      });
    }
    if (path === "/api/inbox/messages") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await options.readBody(req);
      return staleTab(body) ?? (await startThread(body));
    }
    const toMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/to$/.exec(path);
    if (toMatch) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await options.readBody(req);
      return staleTab(body) ?? readdress(toMatch[1]!, body);
    }
    if (path === "/api/inbox/drafts") {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      // `replies` (additive, approval "inbox-reply-drafts"): every open thread holding unsent work
      // (reply words, picks, comments), for the Drafts page's "Replies not sent" and the sidebar's count.
      return json({ serverSession, drafts: listInboxDrafts(store.dir).map(withStatus), replies: replyDraftRows() });
    }
    const draftMatch = /^\/api\/inbox\/drafts\/([A-Za-z0-9_]+)(\/delete)?$/.exec(path);
    if (draftMatch) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await options.readBody(req);
      const stale = staleTab(body);
      if (stale) return stale;
      if (draftMatch[2]) return json({ ok: true, deleted: deleteInboxDraft(store.dir, draftMatch[1]) });
      const draft = saveInboxDraft(store.dir, draftMatch[1], body, now().toISOString());
      return json({ draft: withStatus(draft) });
    }
    if (path === "/api/inbox/uploads") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      // The body is the file, so the stale-tab guard reads the query.
      if (checkServerSession({ serverSession: url.searchParams.get("serverSession") ?? undefined }, serverSession) === "mismatch") {
        return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      }
      const length = Number(req.headers.get("content-length") ?? "");
      if (Number.isFinite(length) && length > INBOX_UPLOAD_MAX_BYTES) {
        throw new InboxError("upload_too_large", `Not attached: a file is at most ${INBOX_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`, { max_bytes: INBOX_UPLOAD_MAX_BYTES });
      }
      const upload = await receiveInboxUpload(store.dir, url.searchParams.get("name"), req.body, { at: now().toISOString() });
      return json({ upload });
    }
    return null;
  };

  /** Open threads holding unsent work, the most recently drafted first (each with the reply's first words). */
  const replyDraftRows = (): InboxReplyDraftRow[] =>
    store
      .listRows()
      .filter((row) => inboxHasUnsent(row.unsent) && !inboxRowArchived(row))
      .map((row) => {
        const words = store.replyDraft(row.thread_id)?.body.trim().replace(/\s+/g, " ") ?? "";
        return { ...row, reply_preview: words ? words.slice(0, INBOX_REPLY_PREVIEW_MAX) : null };
      })
      .sort((a, b) => (b.unsent!.reply_at ?? b.last_at).localeCompare(a.unsent!.reply_at ?? a.last_at) || a.thread_id.localeCompare(b.thread_id));

  /** Forget uploads older than a day that no draft names, and the blobs only they held. */
  const sweep = () => {
    try {
      sweepInboxUploads(store.dir, { keep: inboxDraftUploadIds(store.dir), usedBlobs: store.usedBlobs(), now: now().getTime() });
    } catch {
      // Best effort: the next sweep tries again.
    }
  };

  return { route, sweep, sessionsModel, replayThread, checkSend, writeThread };
}
