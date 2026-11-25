/**
 * Plannotator Inbox: the reply draft of a linked machine's thread (docs/agent-guides/inbox-machines.md, "Reply drafts").
 *
 * The draft lives on the thread's own machine, as the thread does (mark `reply-drafts`): the window here reads, saves
 * and discards it through the forward (`threads/:id/draft`, `threads/:id/draft/delete` at that machine's door), and that
 * machine's stream says when it changes (`drafts=1`). So that machine's windows, its phone and every window here show
 * one draft, as a local thread's draft shows in every window of its own Inbox.
 *
 * While that machine is online and nothing is held for the thread, a save goes straight there and its answer is the
 * window's, a conflict included. When the machine cannot take it now (asleep, offline, no answer), the draft is held
 * here, in a file of its own per thread (inbox-machine-drafts-held.ts), overwritten by each save: never in the outbox,
 * never "waiting", never a notice. This Inbox answers for the draft until it lands, by the same rules that machine's
 * store keeps (@plannotator/core/inbox-reply-draft): the save and its conflict, a read, the row's Draft mark and the
 * Drafts page. So typed words outlive leaving the thread, a reload and a restart while that machine is away.
 *
 * Back online, the thread's newest write lands once (`drain`): saves that never left are folded into one, a Discard
 * takes them with it. A held save that machine refuses because its draft changed there meanwhile keeps both words: its
 * draft's, a blank line, then these (as Take back joins a reply with a kept draft). One whose list names a file swept
 * there since goes again without it. Any other refusal keeps its words as the draft shown here, carried by the
 * thread's next write: a person's words are never dropped. Unlinked, they become a "Not sent" line (`forget`).
 */
import {
  applyReplyDraftFileOps,
  checkReplyDraftConflict,
  composeReplyDraftFileOps,
  projectReplyDraft,
  replyDraftFilesAfter,
  replyDraftPreview,
  settleReplyDraftAfterSend,
  type ReplyDraftFileOps,
  type ReplyDraftFileRef,
} from "@plannotator/core/inbox-reply-draft";
import { inboxHasUnsent, inboxMarksHave, inboxRowArchived, type InboxDraftFile, type InboxListRow, type InboxReplyDraft, type InboxReplyDraftRow, type InboxUpload } from "@plannotator/core/inbox-types";
import { checkInboxReplyDraftInput } from "@plannotator/shared/inbox/reply-drafts";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { readHeldDrafts, removeHeldDraft, writeHeldDraft, type HeldDraft, type HeldDraftWrite } from "./inbox-machine-drafts-held";

/** A forwarded route of a thread's reply draft: its read and save (`draft`), or Discard (`draft/delete`). */
export const MACHINE_DRAFT_ROUTE = /^threads\/([A-Za-z0-9_]+)\/draft(\/delete)?$/;
/** How long a save waits for that machine before it is held, as a forwarded write waits (`MACHINE_WRITE_WAIT_MS`). */
const DRAFT_WAIT_MS = 4_000;
/** How long the Drafts page waits for a far draft's first words. */
const PREVIEW_WAIT_MS = 2_000;
/** Uploads remembered as they pass the forward, so a held draft's tiles keep their names. */
const UPLOADS_KEPT = 200;
/** A held draft that machine could not answer is tried again after this, doubling up to the most. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** What this needs of a machine's line (`PeerLink`). */
export interface DraftPeer {
  readonly id: string;
  state: string;
  list: { marks: readonly string[]; rows: readonly (InboxListRow & { machine: string })[] } | null;
  request(route: string, search: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<Response>;
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
const withOps = (ops: ReplyDraftFileOps): Body => ({ files_add: ops.add, files_remove: ops.remove, files_place: ops.place, ...(ops.order ? { files_order: ops.order } : {}) });
const refOf = (file: InboxDraftFile): ReplyDraftFileRef => ({ upload_id: file.upload_id, ...(file.pasted ? { pasted: file.pasted } : {}) });
const codeOf = (answer: unknown) => (answer && typeof answer === "object" ? (answer as { code?: unknown }).code : undefined);
const draftOf = (answer: unknown): InboxReplyDraft | null => {
  const draft = answer && typeof answer === "object" ? (answer as { draft?: unknown }).draft : null;
  return draft && typeof draft === "object" && typeof (draft as InboxReplyDraft).body === "string" ? (draft as InboxReplyDraft) : null;
};
const keyOf = (body: Body) => (typeof body.idempotency_key === "string" && body.idempotency_key.trim() ? body.idempotency_key.trim() : crypto.randomUUID());

/**
 * `then` after `was`, as one save that stands on `was`'s base, so `was`'s words (which the window shows) go too. Its
 * file changes compose when both are changes; after a whole list (a conflict's join), the whole list again with
 * `then`'s changes. What `then` does not name (recipients, quote, mentions) stays as `was` named it.
 */
const carry = (was: Body, then: Body): Body => {
  const kept: Body = {
    base: was.base ?? null,
    base_body: typeof was.base_body === "string" ? was.base_body : null,
    base_files: Array.isArray(was.base_files) ? was.base_files : null,
    ...(then.recipients === undefined && was.recipients !== undefined ? { recipients: was.recipients } : {}),
    ...(!("quote" in then) && "quote" in was ? { quote: was.quote } : {}),
    ...(then.mentions === undefined && was.mentions !== undefined ? { mentions: was.mentions } : {}),
  };
  if (opsForm(was) && opsForm(then)) return { ...then, ...kept, ...withOps(composeReplyDraftFileOps(opsOf(was), opsOf(then))) };
  if (!opsForm(then)) return { ...then, ...kept };
  const { files_add: _add, files_remove: _remove, files_place: _place, files_order: _order, ...rest } = then;
  return { ...rest, ...kept, files: applyReplyDraftFileOps<ReplyDraftFileRef>(refs(was.files), opsOf(then), { from: words(was), to: words(then) }), all_files: true };
};

/** `then` after `first`, as one write: a Discard drops every save before it; a save after a Discard stands on no draft. */
const fold = (first: HeldDraftWrite | null, then: HeldDraftWrite): HeldDraftWrite => {
  if (!first) return then;
  if (then.discard) return { discard: first.discard ?? then.discard, ...(then.save ? { save: then.save } : {}) };
  if (!then.save) return first;
  if (!first.save) return { ...first, save: { ...then.save, base: null, base_body: null, base_files: null } };
  return { ...first, save: carry(first.save, then.save) };
};

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

export function createMachineDrafts(options: {
  dataDir: string;
  /** A thread's draft changed as this Inbox shows it: every window's stream says `event: drafts`. */
  onChange: (machine: string, threadId: string) => void;
  /** The machine's line: its state, its door, and its list to read again once a held draft landed there. */
  peer: (machine: string) => DraftPeer | undefined;
  now?: () => Date;
  /** Tests: the first pause before a held draft that machine could not answer is tried again. */
  retryMs?: number;
}) {
  const { dataDir } = options;
  const now = options.now ?? (() => new Date());
  const key = (machine: string, threadId: string) => `${machine} ${threadId}`;
  /** The drafts held here, one per thread: the files on disk, read once at start. */
  const held = new Map<string, HeldDraft>();
  for (const record of readHeldDrafts(dataDir)) held.set(key(record.machine, record.thread_id), record);
  /** Each far draft as this Inbox last heard it there (null: none). Absent: not heard since this Inbox started. */
  const known = new Map<string, InboxReplyDraft | null>();
  const uploads = new Map<string, InboxUpload>();
  const draining = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const retries = new Map<string, { timer: ReturnType<typeof setTimeout> | null; ms: number }>();

  const put = (record: HeldDraft) => {
    const { stopped, ...rest } = record;
    const next: HeldDraft = stopped ? { ...rest, stopped } : rest;
    writeHeldDraft(dataDir, next);
    held.set(key(record.machine, record.thread_id), next);
  };
  const drop = (machine: string, threadId: string) => {
    removeHeldDraft(dataDir, machine, threadId);
    held.delete(key(machine, threadId));
  };
  const changed = (machine: string, threadId: string) => options.onChange(machine, threadId);

  /** Where an upload is known here: the shown draft's own file, or one this forward passed. */
  const lookup =
    (prior: InboxReplyDraft | null) =>
    (id: string): InboxUpload | null => {
      const file = prior?.files?.find((f) => f.upload_id === id) ?? uploads.get(id);
      if (!file) return null;
      const { pasted: _pasted, ...upload } = file as InboxDraftFile;
      return upload;
    };

  /**
   * A save held here, by that machine's store's rules (store.ts `saveReplyDraft`): its refusal (the input, or a
   * conflict with the draft held here), or the draft it makes (null: nothing left).
   */
  const project = (threadId: string, prior: InboxReplyDraft | null, body: Body, compare: boolean): { refused: { status: number; body: unknown } } | { view: InboxReplyDraft | null } => {
    let input: ReturnType<typeof checkInboxReplyDraftInput>;
    try {
      input = checkInboxReplyDraftInput(lookup(prior), body);
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      return { refused: { status: error.code.endsWith("_not_found") ? 404 : 422, body: { error: error.message, code: error.code, ...error.details } } };
    }
    if (compare) {
      const conflict = checkReplyDraftConflict(prior, { base: input.base, baseBody: input.baseBody, baseFiles: input.baseFiles, allFiles: input.allFiles, ops: input.ops !== null }, (id) => lookup(prior)(id) !== null);
      if (conflict) return { refused: { status: 409, body: { error: conflict, code: "draft_conflict", draft: prior } } };
    }
    const files = replyDraftFilesAfter(prior, prior?.files ?? [], input.body, input.ops ? { ops: input.ops } : { files: input.files, allFiles: input.allFiles });
    if (input.body.trim() === "" && files.length === 0) return { view: null };
    return { view: projectReplyDraft(threadId, prior, { body: input.body, files, recipients: input.recipients, quote: input.quote, mentions: input.mentions }, now().toISOString()) };
  };

  /** Hold a save or a Discard for that machine: folded into what waits for the thread, and sent once it is back. */
  const hold = (peer: DraftPeer, threadId: string, deleting: boolean, body: Body): DraftAnswer => {
    const machine = peer.id;
    const record = held.get(key(machine, threadId)) ?? null;
    const prior = record ? record.view : (known.get(key(machine, threadId)) ?? null);
    const idempotency_key = keyOf(body);
    let view: InboxReplyDraft | null = null;
    let write: HeldDraftWrite;
    if (deleting) write = { discard: { idempotency_key } };
    else {
      // A second window here a step behind the held draft is refused as that machine's store would refuse it. With
      // nothing held, that machine judges the save when it lands.
      const made = project(threadId, prior, body, record !== null);
      if ("refused" in made) return made.refused;
      view = made.view;
      write = { save: { ...body, idempotency_key } };
    }
    put({ v: 1, machine, thread_id: threadId, view, sent: record?.sent ?? null, next: fold(record?.next ?? null, write) });
    changed(machine, threadId);
    if (peer.state === "online") void drain(machine);
    else peer.poke();
    return deleting ? { status: 200, body: { ok: true, deleted: prior !== null } } : { status: 200, body: { draft: view } };
  };

  /** A save or a Discard from the window. */
  const write = async (peer: DraftPeer, threadId: string, deleting: boolean, body: Body, signal?: AbortSignal): Promise<DraftAnswer> => {
    let sent: Body = { ...body, idempotency_key: keyOf(body) };
    // Nothing held for this thread and that machine is there: its answer is the window's, a conflict included.
    if (!held.has(key(peer.id, threadId)) && peer.state === "online") {
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
        // A list naming a file that machine swept since: the same save without it, so the words land.
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
    return hold(peer, threadId, deleting, sent);
  };

  const noteAnswer = async (machine: string, threadId: string, deleting: boolean, answer: Response) => {
    const body = await answer.json().catch(() => null);
    if (answer.ok) known.set(key(machine, threadId), deleting ? null : draftOf(body));
    else if (codeOf(body) === "draft_conflict") known.set(key(machine, threadId), draftOf(body));
  };

  /** One try of a write there: its answer, or null when that machine did not give one (or gave a 5xx). */
  const post = async (peer: DraftPeer, threadId: string, deleting: boolean, body: Body): Promise<{ status: number; body: unknown } | null> => {
    try {
      const answer = await peer.request(`threads/${threadId}/draft${deleting ? "/delete" : ""}`, "", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs: DRAFT_WAIT_MS });
      const text = await answer.text();
      if (answer.status >= 500 || answer.status === 401) return null;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: answer.status, body: parsed };
    } catch {
      return null;
    }
  };

  /** A held save that machine refused because its draft changed there meanwhile: both words kept, in one draft. */
  const rejoin = (threadId: string, far: InboxReplyDraft | null, mine: InboxReplyDraft): { view: InboxReplyDraft; save: Body } => {
    const both = !!far && far.body.trim() !== "" && mine.body.trim() !== "" && far.body !== mine.body;
    const text = both ? `${far!.body}\n\n${mine.body}` : mine.body.trim() !== "" ? mine.body : (far?.body ?? "");
    const shift = both ? far!.body.length + 2 : 0;
    const theirs = far?.files ?? [];
    const files = [...theirs, ...(mine.files ?? []).filter((file) => !theirs.some((t) => t.upload_id === file.upload_id)).map((file) => (file.pasted ? { ...file, pasted: { ...file.pasted, at: file.pasted.at + shift } } : file))];
    const mentions = [...(both ? (far!.mentions ?? []) : []), ...(mine.mentions ?? []).map((m) => ({ ...m, at: m.at + shift }))];
    const view = projectReplyDraft(threadId, mine, { body: text, files, recipients: mine.recipients ?? [], quote: mine.quote ?? null, mentions }, now().toISOString());
    const save: Body = { body: text, base: far?.updated_at ?? null, base_body: far?.body ?? null, files: files.map(refOf), all_files: true, recipients: mine.recipients ?? [], quote: mine.quote ?? null, mentions, idempotency_key: crypto.randomUUID() };
    return { view, save };
  };

  /**
   * Land the thread's held write there: what left first (again, under its keys), then what was folded behind it, on
   * the draft that left there. True when nothing is left to try now; false: that machine gave no answer (tried later).
   */
  const land = async (peer: DraftPeer, threadId: string): Promise<boolean> => {
    const k = key(peer.id, threadId);
    for (let step = 0; step < 100; step++) {
      let record = held.get(k);
      if (!record || record.stopped) return true;
      if (!record.sent) {
        if (!record.next) {
          drop(peer.id, threadId);
          await peer.refreshList().catch(() => {});
          changed(peer.id, threadId);
          return true;
        }
        // Written before it goes: it may land there from now on, so nothing is folded into it again.
        record = { ...record, sent: record.next, next: null };
        put(record);
      }
      const write = record.sent!;
      if (write.discard) {
        const answer = await post(peer, threadId, true, { idempotency_key: write.discard.idempotency_key });
        if (!answer) return false;
        // Gone there (or nothing to go): the save behind it, if any, stands on no draft.
        known.set(k, null);
        const latest = held.get(k);
        if (!latest) return true;
        put({ ...latest, sent: write.save ? { save: write.save } : null });
        continue;
      }
      const save = write.save!;
      const answer = await post(peer, threadId, false, save);
      if (!answer) return false;
      const current = held.get(k);
      // Unlinked meanwhile: nothing is held for it any more.
      if (!current) return true;
      if (answer.status < 300) {
        const landed = draftOf(answer.body);
        known.set(k, landed);
        // What was folded behind it stands on the draft it left there (its time and words), as a window's next save would.
        const next = current.next?.save && !current.next.discard ? { ...current.next, save: { ...current.next.save, base: landed?.updated_at ?? null, base_body: landed?.body ?? null, base_files: null } } : current.next;
        put({ ...current, sent: null, next });
        continue;
      }
      if (codeOf(answer.body) === "draft_conflict") {
        const far = draftOf(answer.body);
        known.set(k, far);
        if (!current.view) {
          // A Discard waits behind it: the person threw these words away.
          put({ ...current, sent: null });
          continue;
        }
        const joined = rejoin(threadId, far, current.view);
        put({ ...current, view: joined.view, sent: null, next: { save: joined.save } });
        changed(peer.id, threadId);
        continue;
      }
      const again = withoutMissing(save, answer.body);
      if (again) {
        // A file that machine swept since (an upload is kept a day): the same save without it, the words and other files kept.
        const gone = new Set(refs(save.files).filter((ref) => !refs(again.files).some((kept) => kept.upload_id === ref.upload_id)).map((ref) => ref.upload_id));
        let view = current.view;
        if (view) {
          const { files: was, ...rest } = view;
          const files = (was ?? []).filter((file) => !gone.has(file.upload_id));
          view = { ...rest, ...(files.length > 0 ? { files } : {}) };
        }
        put({ ...current, view, sent: { save: again } });
        continue;
      }
      // Any other refusal keeps the words: shown here, and carried by the thread's next write (`hold`). A Discard
      // made meanwhile still goes.
      const folded = fold({ save }, current.next ?? {});
      if (folded.discard) {
        put({ ...current, sent: null, next: folded });
        continue;
      }
      put({ ...current, sent: null, next: folded, stopped: true });
      changed(peer.id, threadId);
      return true;
    }
    return true;
  };

  /** Land what is held for that machine, thread by thread. A call while it runs makes it look again before it ends. */
  const drain = (machine: string): Promise<void> => {
    const running = draining.get(machine);
    if (running) {
      again.add(machine);
      return running;
    }
    const run = (async () => {
      let ok = true;
      do {
        again.delete(machine);
        for (const record of [...held.values()]) {
          const peer = options.peer(machine);
          if (record.machine !== machine || record.stopped) continue;
          if (!peer || peer.state !== "online") return;
          if (!(await land(peer, record.thread_id))) ok = false;
        }
      } while (again.has(machine));
      retryLater(machine, ok);
    })().finally(() => draining.delete(machine));
    draining.set(machine, run);
    return run;
  };

  /** That machine gave no answer for a held draft: tried again after a pause that doubles (reset once one lands). */
  const retryLater = (machine: string, ok: boolean) => {
    const was = retries.get(machine);
    if (was?.timer) clearTimeout(was.timer);
    if (ok) return void retries.delete(machine);
    const ms = Math.min(was ? was.ms * 2 : (options.retryMs ?? RETRY_MIN_MS), RETRY_MAX_MS);
    const timer = setTimeout(() => {
      retries.set(machine, { timer: null, ms });
      if (options.peer(machine)?.state === "online") void drain(machine);
    }, ms);
    timer.unref?.();
    retries.set(machine, { timer, ms });
  };

  return {
    /** A read of the thread's draft this Inbox answers itself: the one held here, or (away) the last one heard. Null: ask that machine. */
    read(peer: DraftPeer, threadId: string): { draft: InboxReplyDraft | null } | null {
      const record = held.get(key(peer.id, threadId));
      if (record) return { draft: record.view };
      const heard = known.get(key(peer.id, threadId));
      return peer.state !== "online" && heard !== undefined ? { draft: heard } : null;
    },
    /** That machine answered a read of the draft: kept as heard. */
    noteRead(machine: string, threadId: string, answer: Response): void {
      if (answer.ok) void noteAnswer(machine, threadId, false, answer);
    },
    write,
    /** That machine is online (its line changed): what is held for it lands. */
    drain,
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
     * A reply held for that machine carried the draft (`clear_draft`): the draft held here settles as that machine
     * will settle it (`settleReplyDraftAfterSend`): gone, or its files the Send did not carry, so the sent words never
     * come back.
     */
    afterReply(peer: DraftPeer, threadId: string, body: Body): void {
      const view = held.get(key(peer.id, threadId))?.view;
      if (!view || typeof body.clear_draft !== "string") return;
      const uploadsSent = strings(body.uploads);
      const after = settleReplyDraftAfterSend(view, { clearDraft: body.clear_draft, words: typeof body.words === "string" ? body.words : undefined, uploads: uploadsSent });
      if (after.kind === "delete") hold(peer, threadId, true, {});
      else if (after.kind === "files") {
        const left = new Set(after.files.map((file) => file.upload_id));
        const remove = (view.files ?? []).filter((file) => !left.has(file.upload_id)).map((file) => file.upload_id);
        const place = after.files.flatMap((file) => (file.pasted ? [{ upload_id: file.upload_id, pasted: file.pasted }] : []));
        hold(peer, threadId, false, { body: "", base: view.updated_at, base_body: view.body, files_add: [], files_remove: remove, files_place: place, recipients: [] });
      }
    },
    /** That machine's rows, each with the Draft mark of a draft held here for it. */
    overlay<R extends InboxListRow & { machine: string }>(rows: readonly R[]): R[] {
      if (held.size === 0) return [...rows];
      return rows.map((row) => {
        const record = held.get(key(row.machine, row.thread_id));
        if (!record) return row;
        const unsent = { ...(row.unsent ?? { reply_at: null, picks: 0, comments: 0 }), reply_at: record.view ? record.view.updated_at : null };
        return { ...row, unsent: inboxHasUnsent(unsent) ? unsent : null };
      });
    },
    /** The Drafts page's rows of linked machines that keep reply drafts: each open thread there holding unsent work. */
    async rowsFor(peers: readonly DraftPeer[], rows: readonly (InboxListRow & { machine: string })[]): Promise<InboxReplyDraftRow[]> {
      const takers = new Map(peers.filter((peer) => inboxMarksHave(peer.list?.marks, "reply-drafts")).map((peer) => [peer.id, peer]));
      const open = rows.filter((row) => takers.has(row.machine) && inboxHasUnsent(row.unsent) && !inboxRowArchived(row));
      return Promise.all(
        open.map(async (row) => {
          const peer = takers.get(row.machine)!;
          const record = held.get(key(peer.id, row.thread_id));
          let draft: InboxReplyDraft | null | undefined = record ? record.view : undefined;
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
          return { ...row, reply_preview: replyDraftPreview(draft) };
        }),
      );
    },
    /** How many threads hold a draft here for that machine, not landed yet: Unlink says they would be lost. */
    heldCount(machine: string): number {
      return [...held.values()].filter((record) => record.machine === machine).length;
    },
    /**
     * That machine is no longer linked: what is held for it goes. Each draft's words, for the "Not sent" list (as a
     * write that was waiting for it), so they can still be copied.
     */
    forget(machine: string): { thread: string; words: string }[] {
      const lost: { thread: string; words: string }[] = [];
      for (const record of [...held.values()]) {
        if (record.machine !== machine) continue;
        const text = record.view?.body.trim() ? record.view.body : (record.view?.files?.[0]?.pasted?.preview ?? "");
        if (text) lost.push({ thread: record.thread_id, words: text });
        drop(machine, record.thread_id);
      }
      const retry = retries.get(machine);
      if (retry?.timer) clearTimeout(retry.timer);
      retries.delete(machine);
      for (const k of [...known.keys()]) if (k.startsWith(`${machine} `)) known.delete(k);
      return lost;
    },
  };
}

export type MachineDrafts = ReturnType<typeof createMachineDrafts>;
