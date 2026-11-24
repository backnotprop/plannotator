/**
 * Plannotator Inbox: the reply draft of a linked machine's thread (docs/agent-guides/inbox-machines.md, "Reply drafts").
 *
 * The draft lives on the thread's own machine, as the thread does (mark `reply-drafts`): the window here reads, saves
 * and discards it through the forward (`threads/:id/draft`, `threads/:id/draft/delete` at that machine's door), and that
 * machine's stream says when it changes (`drafts=1`). So that machine's windows, its phone and every window here show
 * one draft, as a local thread's draft shows in every window of its own Inbox.
 *
 * While that machine is online and nothing waits for the thread, a save goes straight there and its answer is the
 * window's, a conflict included. When the machine cannot take it now (asleep, offline, no answer), the write is held in
 * the outbox as this Inbox's own (`auto`: never "waiting", never a notice), with the draft the window should see
 * (`draft.view`), and this Inbox answers for the draft until it lands: the save, a read, the row's Draft mark and the
 * Drafts page. So typed words outlive leaving the thread, a reload and a restart while that machine is away. Held writes
 * of a thread go in order; a save that never left is folded into the next one (its file changes too), and a Discard
 * takes those with it. A held save that machine refuses because its draft changed there meanwhile keeps both words:
 * its draft's, a blank line, then these (as Take back joins a reply with a kept draft). One whose list names a file
 * swept there since goes again without it. Any other refusal keeps its words as the draft shown here, carried by the
 * thread's next write: a person's words are never dropped.
 */
import { applyReplyDraftFileOps, composeReplyDraftFileOps, settleReplyDraftAfterSend, type ReplyDraftFileOps, type ReplyDraftFileRef } from "@plannotator/core/inbox-reply-draft";
import { INBOX_DRAFT_BODY_MAX, inboxHasUnsent, inboxRowArchived, type InboxDraftFile, type InboxListRow, type InboxReplyDraft, type InboxReplyDraftRow, type InboxUpload } from "@plannotator/core/inbox-types";
import type { InboxOutbox, OutboxEntry } from "./inbox-outbox";

/** A forwarded route of a thread's reply draft: its read and save (`draft`), or Discard (`draft/delete`). */
export const MACHINE_DRAFT_ROUTE = /^threads\/([A-Za-z0-9_]+)\/draft(\/delete)?$/;
/** The mark a machine's list carries when its door takes reply drafts from a linked machine. */
export const REPLY_DRAFTS_MARK = "reply-drafts";
/** How long a save waits for that machine before it is held, as a forwarded write waits (`MACHINE_WRITE_WAIT_MS`). */
const DRAFT_WAIT_MS = 4_000;
/** How long the Drafts page waits for a far draft's first words. */
const PREVIEW_WAIT_MS = 2_000;
/** As the Drafts page's own rows (inbox-compose.ts). */
const PREVIEW_MAX = 160;
/** Uploads remembered as they pass the forward, so a held draft's tiles keep their names. */
const UPLOADS_KEPT = 200;

/** What this needs of a machine's line (`PeerLink`). */
export interface DraftPeer {
  readonly id: string;
  state: string;
  list: { marks: readonly string[]; rows: readonly (InboxListRow & { machine: string })[] } | null;
  request(route: string, search: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<Response>;
  flush(): void;
  poke(): void;
  refreshList(): Promise<void>;
}

/** The forward's answer: that machine's own (passed on as it came), or this Inbox's for a held write. */
export type DraftAnswer = { far: Response } | { status: number; body: unknown };

type Body = Record<string, unknown>;
const words = (body: Body) => (typeof body.body === "string" ? body.body : "");
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const refs = (value: unknown): ReplyDraftFileRef[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item === "string") return [{ upload_id: item }];
        if (!item || typeof item !== "object" || typeof (item as { upload_id?: unknown }).upload_id !== "string") return [];
        const ref = item as ReplyDraftFileRef;
        return [{ upload_id: ref.upload_id, ...(ref.pasted ? { pasted: ref.pasted } : {}) }];
      })
    : [];
/** A save that names its file changes (every Inbox page since 0.28.47), as opposed to a whole list. */
const opsForm = (body: Body) => Array.isArray(body.files_add) || Array.isArray(body.files_remove) || Array.isArray(body.files_place);
const opsOf = (body: Body): ReplyDraftFileOps => ({
  add: refs(body.files_add),
  remove: strings(body.files_remove),
  place: refs(body.files_place).flatMap((ref) => (ref.pasted ? [{ upload_id: ref.upload_id, pasted: ref.pasted }] : [])),
  ...(Array.isArray(body.files_order) ? { order: strings(body.files_order) } : {}),
});
const refOf = (file: InboxDraftFile): ReplyDraftFileRef => ({ upload_id: file.upload_id, ...(file.pasted ? { pasted: file.pasted } : {}) });
const codeOf = (answer: unknown) => (answer && typeof answer === "object" ? (answer as { code?: unknown }).code : undefined);
const draftOf = (answer: unknown): InboxReplyDraft | null => {
  const draft = answer && typeof answer === "object" ? (answer as { draft?: unknown }).draft : null;
  return draft && typeof draft === "object" && typeof (draft as InboxReplyDraft).body === "string" ? (draft as InboxReplyDraft) : null;
};
/** The words a Drafts row shows (inbox-compose.ts `replyDraftRows`). */
const previewOf = (draft: InboxReplyDraft | null) => {
  const first = draft?.files?.[0];
  const text = (draft?.body.trim() || first?.pasted?.preview || first?.name || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, PREVIEW_MAX) : null;
};

export function createMachineDrafts(options: {
  outbox: InboxOutbox;
  /** A thread's draft changed as this Inbox shows it: every window's stream says `event: drafts`. */
  onChange: (machine: string, threadId: string) => void;
  /** The machine's line, to read its list again once a held draft landed there. */
  peer: (machine: string) => DraftPeer | undefined;
  now?: () => Date;
}) {
  const { outbox } = options;
  const now = options.now ?? (() => new Date());
  const key = (machine: string, threadId: string) => `${machine} ${threadId}`;
  /** Each far draft as this Inbox last heard it there (null: none). Absent: not heard since this Inbox started. */
  const known = new Map<string, InboxReplyDraft | null>();
  const uploads = new Map<string, InboxUpload>();

  /** The newest held write of a thread's draft that has not landed yet. */
  const held = (machine: string, threadId: string): OutboxEntry | null =>
    outbox
      .list(machine, "pending")
      .filter((entry) => entry.draft && entry.thread === threadId)
      .at(-1) ?? null;

  /**
   * Each thread's held save that machine did not take (refused for another reason than a conflict, parked, or the
   * link gone), when it is the thread's newest write: its words are the draft shown here until the next write carries
   * them, so a refusal never takes the person's words.
   */
  const strandedOf = (machine: string): Map<string, OutboxEntry> => {
    const newest = new Map<string, OutboxEntry>();
    for (const entry of outbox.list(machine)) {
      if (!entry.draft || !entry.thread || entry.state === "cancelled") continue;
      const before = newest.get(entry.thread);
      if (!before || entry.n > before.n) newest.set(entry.thread, entry);
    }
    for (const [threadId, entry] of newest) {
      const lost = entry.state === "refused" || entry.state === "parked" || entry.state === "dropped";
      if (!lost || entry.notice === null || entry.dismissed || entry.route.endsWith("/delete") || entry.draft!.view === null) newest.delete(threadId);
    }
    return newest;
  };
  const stranded = (machine: string, threadId: string): OutboxEntry | null => strandedOf(machine).get(threadId) ?? null;

  const stamp = (prior: InboxReplyDraft | null) => {
    const at = now().toISOString();
    return prior && at <= prior.updated_at ? new Date(Date.parse(prior.updated_at) + 1).toISOString() : at;
  };
  /** A file as the draft shows it: the prior draft's, or the upload this forward passed. Unknown: not shown until it lands. */
  const fileOf = (prior: InboxReplyDraft | null, ref: ReplyDraftFileRef): InboxDraftFile | null => {
    const upload = prior?.files?.find((file) => file.upload_id === ref.upload_id) ?? uploads.get(ref.upload_id);
    if (!upload) return null;
    const { pasted: _pasted, ...rest } = upload as InboxDraftFile;
    return { ...rest, ...(ref.pasted ? { pasted: ref.pasted } : {}) };
  };

  /** The draft after a save, as that machine's store will write it (null: nothing left). */
  const viewAfter = (threadId: string, prior: InboxReplyDraft | null, body: Body): InboxReplyDraft | null => {
    const text = words(body);
    const list = opsForm(body)
      ? applyReplyDraftFileOps<InboxDraftFile>(
          prior?.files ?? [],
          { ...opsOf(body), add: opsOf(body).add.flatMap((ref) => fileOf(prior, ref) ?? []), place: opsOf(body).place },
          prior ? { from: prior.body, to: text } : undefined,
        )
      : refs(body.files).flatMap((ref) => fileOf(prior, ref) ?? []);
    if (text.trim() === "" && list.length === 0) return null;
    const at = stamp(prior);
    const recipients = Array.isArray(body.recipients) ? strings(body.recipients) : (prior?.recipients ?? []);
    const quote = "quote" in body ? (body.quote && typeof body.quote === "object" && typeof (body.quote as { of?: unknown }).of === "string" ? (body.quote as InboxReplyDraft["quote"]) : undefined) : prior?.quote;
    const mentions = Array.isArray(body.mentions) ? (body.mentions as InboxReplyDraft["mentions"]) : prior?.mentions;
    return {
      v: 1,
      thread_id: threadId,
      body: text,
      created_at: prior?.created_at ?? at,
      updated_at: at,
      ...(list.length > 0 ? { files: list } : {}),
      ...(recipients.length > 0 ? { recipients } : {}),
      ...(quote ? { quote } : {}),
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
    };
  };

  const changed = (machine: string, threadId: string) => options.onChange(machine, threadId);

  /** Queue a write of the thread's draft for that machine, shown as `view` until it lands. */
  const queue = (peer: DraftPeer, threadId: string, deleting: boolean, body: Body, view: InboxReplyDraft | null): void => {
    const route = `threads/${threadId}/draft${deleting ? "/delete" : ""}`;
    outbox.submit(peer.id, route, { ...body, idempotency_key: typeof body.idempotency_key === "string" && body.idempotency_key ? body.idempotency_key : crypto.randomUUID() }, threadId, false, null, true, { draft: { view } });
    changed(peer.id, threadId);
    if (peer.state === "online") peer.flush();
    else peer.poke();
  };

  /** Hold a save or a Discard for that machine: in order behind what waits, a save that never left folded into this one. */
  const hold = (peer: DraftPeer, threadId: string, deleting: boolean, body: Body, from?: InboxReplyDraft | null): DraftAnswer => {
    const machine = peer.id;
    let last = held(machine, threadId);
    if (!deleting && words(body).length > INBOX_DRAFT_BODY_MAX) {
      // As that machine's store refuses it: the box says the words are too long, and keeps them.
      return { status: 422, body: { error: `body: a string of at most ${INBOX_DRAFT_BODY_MAX} characters.`, code: "validation_error", field: "body" } };
    }
    const prior = last ? last.draft!.view : from !== undefined ? from : (known.get(key(machine, threadId)) ?? null);
    if (deleting) {
      // Discard: nothing before it that never left needs to go any more.
      for (const entry of outbox.list(machine, "pending")) if (entry.draft && entry.thread === threadId && !entry.left) outbox.cancel(entry.key);
      queue(peer, threadId, true, body, null);
      return { status: 200, body: { ok: true, deleted: prior !== null } };
    }
    if (last) {
      // A second window here a step behind this one is refused as that machine's store would refuse it.
      const view = last.draft!.view;
      const base = typeof body.base === "string" ? body.base : null;
      const mine = typeof body.base_body === "string" && view !== null && view.body === body.base_body;
      if ((view?.updated_at ?? null) !== base && !mine) {
        return { status: 409, body: { error: view ? "This reply changed in another window since you opened it." : "This reply's draft was discarded or sent in another window.", code: "draft_conflict", draft: view } };
      }
    }
    const view = viewAfter(threadId, prior, body);
    let far: Body = body;
    if (last && !last.left && last.state === "queued" && last.route.endsWith("/draft") && opsForm(last.body) && opsForm(body)) {
      // Folded: the earlier save never left, so this one carries its file changes and stands on its base.
      if (outbox.cancel(last.key)?.state === "cancelled") {
        far = {
          ...body,
          base: last.body.base ?? null,
          ...(typeof last.body.base_body === "string" ? { base_body: last.body.base_body } : { base_body: null }),
          ...withOps(composeReplyDraftFileOps(opsOf(last.body), opsOf(body))),
          ...(body.recipients === undefined && last.body.recipients !== undefined ? { recipients: last.body.recipients } : {}),
          ...(!("quote" in body) && "quote" in last.body ? { quote: last.body.quote } : {}),
          ...(body.mentions === undefined && last.body.mentions !== undefined ? { mentions: last.body.mentions } : {}),
        };
        last = held(machine, threadId);
      }
    }
    if (last) {
      // Behind a held write: the draft that machine will hold once it lands (its words, or none at all). Its time
      // there is not known yet, so its words (`base_body`) say the draft is this window's.
      const before = last.draft!.view;
      far = { ...far, base: before === null ? null : (last.body.base ?? null), base_body: before === null ? null : before.body };
    }
    queue(peer, threadId, false, far, view);
    return { status: 200, body: { draft: view } };
  };

  /** A save or a Discard from the window. */
  const write = async (peer: DraftPeer, threadId: string, deleting: boolean, body: Body, signal?: AbortSignal): Promise<DraftAnswer> => {
    let sent: Body = { ...body, idempotency_key: typeof body.idempotency_key === "string" && body.idempotency_key.trim() ? body.idempotency_key.trim() : crypto.randomUUID() };
    // A save that machine did not take is the draft the window shows: this write carries its words, on its base.
    const left = stranded(peer.id, threadId);
    if (left) {
      outbox.dismiss(left.key);
      if (!deleting) sent = carry(left, sent);
    }
    // Nothing waits for this thread and that machine is there: its answer is the window's, a conflict included.
    if (!held(peer.id, threadId) && peer.state === "online") {
      try {
        const send = () =>
          peer.request(`threads/${threadId}/draft${deleting ? "/delete" : ""}`, "", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(deleting ? { idempotency_key: sent.idempotency_key } : sent),
            signal,
            timeoutMs: DRAFT_WAIT_MS,
          });
        let far = await send();
        // A carried list naming a file that machine swept since: the same save without it, so the words land.
        for (let tries = 0; far.status === 404 && !deleting && tries < 50; tries++) {
          const next = withoutMissing(sent, await far.clone().json().catch(() => null));
          if (!next) break;
          await far.body?.cancel().catch(() => {});
          sent = next;
          far = await send();
        }
        if (far.status < 500) {
          void noteAnswer(peer.id, threadId, deleting, far.clone());
          return { far };
        }
        await far.body?.cancel().catch(() => {});
      } catch {
        // Not there after all, or too slow: held below, under the same key (its door answers a key it saw once).
      }
    }
    return hold(peer, threadId, deleting, sent, left && !deleting ? left.draft!.view : undefined);
  };

  /**
   * The window's save after one that machine did not take (`stranded`): that save's change and this one's, on the base
   * that save stood on, so its words (which the window shows) go there too. Its file changes compose when both are
   * changes; after a whole list (a conflict's join), the whole list again with this save's changes.
   */
  const carry = (left: OutboxEntry, body: Body): Body => {
    const was = left.body;
    const kept: Body = {
      base: was.base ?? null,
      base_body: typeof was.base_body === "string" ? was.base_body : null,
      ...(body.recipients === undefined && was.recipients !== undefined ? { recipients: was.recipients } : {}),
      ...(!("quote" in body) && "quote" in was ? { quote: was.quote } : {}),
      ...(body.mentions === undefined && was.mentions !== undefined ? { mentions: was.mentions } : {}),
    };
    if (opsForm(was) && opsForm(body)) return { ...body, ...kept, ...withOps(composeReplyDraftFileOps(opsOf(was), opsOf(body))) };
    if (!opsForm(body)) return { ...body, ...kept };
    const { files_add: _add, files_remove: _remove, files_place: _place, files_order: _order, ...rest } = body;
    return { ...rest, ...kept, files: applyReplyDraftFileOps<ReplyDraftFileRef>(refs(was.files), opsOf(body), { from: words(was), to: words(body) }), all_files: true };
  };

  const noteAnswer = async (machine: string, threadId: string, deleting: boolean, answer: Response) => {
    const body = await answer.json().catch(() => null);
    if (answer.ok) known.set(key(machine, threadId), deleting ? null : draftOf(body));
    else if (codeOf(body) === "draft_conflict") known.set(key(machine, threadId), draftOf(body));
  };

  /** A held save that machine refused because its draft changed there meanwhile: both words kept, in one draft. */
  const rejoin = (peer: DraftPeer, threadId: string, far: InboxReplyDraft | null, mine: InboxReplyDraft) => {
    const both = !!far && far.body.trim() !== "" && mine.body.trim() !== "" && far.body !== mine.body;
    const text = both ? `${far!.body}\n\n${mine.body}` : mine.body.trim() !== "" ? mine.body : (far?.body ?? "");
    const shift = both ? far!.body.length + 2 : 0;
    const theirs = far?.files ?? [];
    const files = [...theirs, ...(mine.files ?? []).filter((file) => !theirs.some((t) => t.upload_id === file.upload_id)).map((file) => (file.pasted ? { ...file, pasted: { ...file.pasted, at: file.pasted.at + shift } } : file))];
    const mentions = [...(both ? (far!.mentions ?? []) : []), ...(mine.mentions ?? []).map((m) => ({ ...m, at: m.at + shift }))];
    const view: InboxReplyDraft = { ...mine, body: text, updated_at: stamp(mine), ...(files.length > 0 ? { files } : {}), ...(mentions.length > 0 ? { mentions } : {}) };
    if (files.length === 0) delete view.files;
    if (mentions.length === 0) delete view.mentions;
    queue(
      peer,
      threadId,
      false,
      { body: text, base: far?.updated_at ?? null, base_body: far?.body ?? null, files: files.map(refOf), all_files: true, recipients: mine.recipients ?? [], quote: mine.quote ?? null, mentions },
      view,
    );
  };

  outbox.onChange(({ machine, entry }) => {
    // A dismissed one: its words went on with a newer write.
    if (!entry.draft || !entry.thread || entry.dismissed || entry.state === "queued" || entry.state === "sending" || entry.state === "cancelled") return;
    const threadId = entry.thread;
    const peer = options.peer(machine);
    const deleting = entry.route.endsWith("/delete");
    if (entry.state === "delivered") known.set(key(machine, threadId), deleting ? null : draftOf(entry.answer));
    else if (entry.state === "refused" && codeOf(entry.answer) === "draft_conflict") known.set(key(machine, threadId), draftOf(entry.answer));
    // Only the newest write of the thread decides: the ones behind it go on as they were queued (and carry its words).
    if (held(machine, threadId)) return;
    if (peer && entry.state === "refused" && codeOf(entry.answer) === "draft_conflict" && entry.draft.view) {
      rejoin(peer, threadId, draftOf(entry.answer), entry.draft.view);
      outbox.dismiss(entry.key);
      return;
    }
    const next = peer && entry.state === "refused" && !deleting && entry.draft.view ? withoutMissing(entry.body, entry.answer) : null;
    if (peer && next) {
      // A file that machine swept since (an upload is kept a day): the same save without it, the words and other files kept.
      const gone = new Set(refs(entry.body.files).map((ref) => ref.upload_id));
      for (const ref of refs(next.files)) gone.delete(ref.upload_id);
      const view = entry.draft.view!;
      const files = (view.files ?? []).filter((file) => !gone.has(file.upload_id));
      const { files: _files, ...rest } = view;
      queue(peer, threadId, false, next, { ...rest, ...(files.length > 0 ? { files } : {}) });
      outbox.dismiss(entry.key);
      return;
    }
    // Any other refusal keeps the words: the thread's draft here is that save's (`strandedOf`) until the next write.
    // Landed (or given up): that machine's list says the Draft mark again before the windows read it.
    void (peer && entry.state === "delivered" ? peer.refreshList() : Promise.resolve()).finally(() => changed(machine, threadId));
  });

  return {
    /** A read of the thread's draft this Inbox answers itself: the one waiting to land, or (away) the last one heard. Null: ask that machine. */
    read(peer: DraftPeer, threadId: string): { draft: InboxReplyDraft | null } | null {
      const last = held(peer.id, threadId);
      if (last) return { draft: last.draft!.view };
      const left = stranded(peer.id, threadId);
      if (left) return { draft: left.draft!.view };
      const heard = known.get(key(peer.id, threadId));
      return peer.state !== "online" && heard !== undefined ? { draft: heard } : null;
    },
    /** That machine answered a read of the draft: kept as heard. */
    noteRead(machine: string, threadId: string, answer: Response): void {
      if (answer.ok) void noteAnswer(machine, threadId, false, answer);
    },
    write,
    /** That machine said its draft changed (another window there, a phone, a Send): heard again on the next read. */
    farChanged(machine: string, threadId: string): void {
      known.delete(key(machine, threadId));
    },
    /** A file uploaded to that machine through the forward: a held draft shows its tile by it. */
    noteUpload(answer: Response): void {
      void answer.json().then(
        (body: { upload?: InboxUpload }) => {
          if (!body?.upload?.upload_id) return;
          uploads.set(body.upload.upload_id, body.upload);
          if (uploads.size > UPLOADS_KEPT) uploads.delete(uploads.keys().next().value!);
        },
        () => {},
      );
    },
    /**
     * A reply held for that machine carried the draft (`clear_draft`): the draft shown here settles as that machine
     * will settle it (`settleReplyDraftAfterSend`), and a Discard goes behind the reply, so the sent words never come back.
     */
    afterReply(peer: DraftPeer, threadId: string, body: Body): void {
      const left = held(peer.id, threadId) ? null : stranded(peer.id, threadId);
      const view = (left ?? held(peer.id, threadId))?.draft?.view;
      if (!view || typeof body.clear_draft !== "string") return;
      const after = settleReplyDraftAfterSend(view, { clearDraft: body.clear_draft, words: typeof body.words === "string" ? body.words : undefined, uploads: strings(body.uploads) });
      if (after.kind !== "delete") return;
      // The Send carried words that machine never took: they are sent, and its older draft goes too.
      if (left) outbox.dismiss(left.key);
      hold(peer, threadId, true, {});
    },
    /** That machine's rows, each with the Draft mark of a draft waiting to land there. */
    overlay<R extends InboxListRow & { machine: string }>(rows: readonly R[]): R[] {
      const views = new Map<string, InboxReplyDraft | null>();
      for (const machine of new Set(rows.map((row) => row.machine))) {
        for (const [threadId, entry] of strandedOf(machine)) views.set(key(machine, threadId), entry.draft!.view);
        for (const entry of outbox.list(machine, "pending")) if (entry.draft && entry.thread) views.set(key(machine, entry.thread), entry.draft.view);
      }
      if (views.size === 0) return [...rows];
      return rows.map((row) => {
        const k = key(row.machine, row.thread_id);
        if (!views.has(k)) return row;
        const view = views.get(k) ?? null;
        const unsent = { ...(row.unsent ?? { reply_at: null, picks: 0, comments: 0 }), reply_at: view ? view.updated_at : null };
        return { ...row, unsent: inboxHasUnsent(unsent) ? unsent : null };
      });
    },
    /** The Drafts page's rows of linked machines that keep reply drafts: each open thread there holding unsent work. */
    async rowsFor(peers: readonly DraftPeer[], rows: readonly (InboxListRow & { machine: string })[]): Promise<InboxReplyDraftRow[]> {
      const takers = new Map(peers.filter((peer) => peer.list?.marks.includes(REPLY_DRAFTS_MARK)).map((peer) => [peer.id, peer]));
      const open = rows.filter((row) => takers.has(row.machine) && inboxHasUnsent(row.unsent) && !inboxRowArchived(row));
      return Promise.all(
        open.map(async (row) => {
          const peer = takers.get(row.machine)!;
          let draft: InboxReplyDraft | null | undefined = (held(peer.id, row.thread_id) ?? stranded(peer.id, row.thread_id))?.draft?.view;
          if (draft === undefined) {
            const heard = known.get(key(peer.id, row.thread_id));
            if (heard !== undefined && (heard?.updated_at ?? null) === row.unsent!.reply_at) draft = heard;
          }
          if (draft === undefined && row.unsent!.reply_at !== null && peer.state === "online") {
            const answer = await peer.request(`threads/${row.thread_id}/draft`, "", { method: "GET", headers: {}, timeoutMs: PREVIEW_WAIT_MS }).catch(() => null);
            const body = answer?.ok ? await answer.json().catch(() => null) : null;
            if (body) {
              draft = draftOf(body);
              known.set(key(peer.id, row.thread_id), draft);
            }
          }
          return { ...row, reply_preview: previewOf(draft ?? null) };
        }),
      );
    },
  };
}

/**
 * A save whose whole list names a file that machine no longer holds (`404 upload_not_found`, `field: files[i]`; an
 * upload is kept a day): the same save without that file, under a new key. Which file is not said: the words go on
 * that machine's files as they are. Null: not that refusal.
 */
const withoutMissing = (body: Body, answer: unknown): Body | null => {
  if (codeOf(answer) !== "upload_not_found" || !Array.isArray(body.files)) return null;
  const field = (answer as { field?: unknown }).field;
  const at = typeof field === "string" ? /^files\[(\d+)\]$/.exec(field) : null;
  const index = at ? Number(at[1]) : -1;
  const idempotency_key = crypto.randomUUID();
  if (index < 0 || index >= body.files.length) {
    const { files: _files, all_files: _all, ...rest } = body;
    return { ...rest, idempotency_key, files_add: [], files_remove: [], files_place: [] };
  }
  return { ...body, idempotency_key, files: body.files.filter((_, i) => i !== index) };
};

const withOps = (ops: ReplyDraftFileOps): Body => ({ files_add: ops.add, files_remove: ops.remove, files_place: ops.place, ...(ops.order ? { files_order: ops.order } : {}) });

export type MachineDrafts = ReturnType<typeof createMachineDrafts>;
