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
 * Back online, the thread's newest write lands once (`drain`): saves that never left are folded into one (checked as
 * that machine checks a save), a Discard takes them with it. A Discard goes only for the draft the person threw away: a
 * draft changed there since stays, and the windows show it. A held save that machine refuses because its draft changed
 * there meanwhile is a conflict as on this computer: its draft shows, and the person's words are offered in every window
 * (`not_landed`: Keep mine / Discard mine) until they choose; never joined by themselves. One whose list names a file
 * swept there since goes again without it. Any other refusal keeps its words as the draft shown here, said "Not saved",
 * carried by the thread's next write: a person's words are never dropped. Unlinked, they become a "Not sent" line
 * (`forget`), every word of them.
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

/**
 * Words of the person's for the thread that the draft there does not hold (a read's `not_landed`): `conflict`, the draft
 * there changed first (offered as a conflict is); otherwise that machine refused them ("Not saved"). `version`: the
 * draft they were here (Discard mine names it).
 */
export interface DraftNotLanded {
  words: string;
  version: string;
  conflict?: true;
}

/** A lost draft's words for the "Not sent" list (`forget`): every word, its files' names and what it quoted. */
export interface LostDraft {
  thread: string;
  words: string;
  files: string[];
  quote: { of: string; words?: string } | null;
}

/** A lost draft's words as the "Not sent" list holds them, each part small enough for one held write (40,000 characters). */
export function lostDraftParts(lost: LostDraft, size = 40_000): string[] {
  const lines = [lost.words.trim() === "" ? "" : lost.words];
  if (lost.quote) lines.push(lost.quote.words ? `Replying to words in a message: “${lost.quote.words}”` : "Replying to a message");
  if (lost.files.length > 0) lines.push(`Attached: ${lost.files.join(", ")}`);
  const text = lines.filter(Boolean).join("\n\n");
  const parts: string[] = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + size, text.length);
    // Never between the two halves of an emoji.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts;
}

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
const placesOf = (draft: InboxReplyDraft | null) => (draft?.files ?? []).flatMap((file) => (file.pasted ? [{ upload_id: file.upload_id, pasted: file.pasted }] : []));
const codeOf = (answer: unknown) => (answer && typeof answer === "object" ? (answer as { code?: unknown }).code : undefined);
const draftOf = (answer: unknown): InboxReplyDraft | null => {
  const draft = answer && typeof answer === "object" ? (answer as { draft?: unknown }).draft : null;
  return draft && typeof draft === "object" && typeof (draft as InboxReplyDraft).body === "string" ? (draft as InboxReplyDraft) : null;
};
const keyOf = (body: Body) => (typeof body.idempotency_key === "string" && body.idempotency_key.trim() ? body.idempotency_key.trim() : crypto.randomUUID());
/** A held write still to go there (as opposed to a record that only offers words that did not land). */
const waits = (record: HeldDraft) => record.sent !== null || record.next !== null || !!record.stopped || !!record.sending;
/** Any upload id is one, for checking a save's shape and places only (that machine knows which files it holds). */
const anyUpload = (id: string): InboxUpload => ({ upload_id: id, name: id, size: 0, kind: "file", sha256: "", created_at: "" }) as InboxUpload;

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
 * A folded save as it goes there: each long paste at its place in the draft shown here (`view`, made save by save by
 * that machine's rules), one this Inbox does not hold kept within the words, then checked as that machine checks a
 * save (`checkInboxReplyDraftInput`). Throws that machine's refusal when it still would not take it.
 */
const aligned = (save: Body, view: InboxReplyDraft | null): Body => {
  const length = words(save).length;
  const shown = new Map(placesOf(view).map((entry) => [entry.upload_id, entry.pasted]));
  const at = <R extends ReplyDraftFileRef>(ref: R): R => {
    if (!ref.pasted) return ref;
    const pasted = shown.get(ref.upload_id) ?? { ...ref.pasted, at: Math.min(Math.max(0, ref.pasted.at), length) };
    return { ...ref, pasted };
  };
  let out = save;
  if (opsForm(save)) {
    const ops = opsOf(save);
    const place = [...ops.place.map(at), ...[...shown].filter(([id]) => !ops.place.some((entry) => entry.upload_id === id)).map(([upload_id, pasted]) => ({ upload_id, pasted }))];
    out = { ...save, ...withOps({ ...ops, add: ops.add.map(at), place }) };
  } else if (Array.isArray(save.files)) out = { ...save, files: refs(save.files).map(at) };
  checkInboxReplyDraftInput(anyUpload, out);
  return out;
};

/** The person's words as a save of their own: on `on` (that machine's draft now, null: none), every file of theirs added. */
const saveOf = (mine: InboxReplyDraft, on: InboxReplyDraft | null, body = mine.body): Body => ({
  body,
  base: on?.updated_at ?? null,
  base_body: on?.body ?? null,
  files_add: (mine.files ?? []).map(refOf),
  files_remove: [],
  files_place: placesOf(mine).filter((entry) => entry.pasted.at <= body.length),
  recipients: mine.recipients ?? [],
  quote: mine.quote ?? null,
  ...(body === mine.body ? { mentions: mine.mentions ?? [] } : {}),
  idempotency_key: crypto.randomUUID(),
});

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
  /** How a reply held for that machine stands (its outbox key): a draft it carried settles once it is delivered. */
  replyState?: (key: string) => "pending" | "delivered" | "refused";
  now?: () => Date;
  /** Tests: the first pause before a held draft that machine could not answer is tried again. */
  retryMs?: number;
  log?: (line: string) => void;
}) {
  const { dataDir } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.error(line));
  const key = (machine: string, threadId: string) => `${machine} ${threadId}`;
  /** The drafts held here, one per thread: the files on disk, read once at start. */
  const held = new Map<string, HeldDraft>();
  for (const record of readHeldDrafts(dataDir, log)) held.set(key(record.machine, record.thread_id), record);
  /** Each far draft as this Inbox last heard it there (null: none). Absent: not heard since this Inbox started. */
  const known = new Map<string, InboxReplyDraft | null>();
  const uploads = new Map<string, InboxUpload>();
  const draining = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const retries = new Map<string, { timer: ReturnType<typeof setTimeout> | null; ms: number }>();
  let failedOnce = false;

  /** Written to disk first: memory follows only once the file holds it (a full disk leaves both as they were). */
  const put = (record: HeldDraft) => {
    const next = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as unknown as HeldDraft;
    writeHeldDraft(dataDir, next);
    held.set(key(record.machine, record.thread_id), next);
  };
  const drop = (machine: string, threadId: string) => {
    removeHeldDraft(dataDir, machine, threadId);
    held.delete(key(machine, threadId));
  };
  const changed = (machine: string, threadId: string) => options.onChange(machine, threadId);
  /** The words a read offers besides the draft: a conflict's, or words that machine refused. */
  const notLandedOf = (record: HeldDraft | undefined): DraftNotLanded | null => {
    if (record?.conflict) return { words: record.conflict.body, version: record.conflict.updated_at, conflict: true };
    if (record?.stopped && record.view && record.view.body.trim() !== "") return { words: record.view.body, version: record.view.updated_at };
    return null;
  };

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
      return { refused: refusal(error) };
    }
    if (compare) {
      const conflict = checkReplyDraftConflict(prior, { base: input.base, baseBody: input.baseBody, baseFiles: input.baseFiles, allFiles: input.allFiles, ops: input.ops !== null }, (id) => lookup(prior)(id) !== null);
      if (conflict) return { refused: { status: 409, body: { error: conflict, code: "draft_conflict", draft: prior } } };
    }
    const files = replyDraftFilesAfter(prior, prior?.files ?? [], input.body, input.ops ? { ops: input.ops } : { files: input.files, allFiles: input.allFiles });
    if (input.body.trim() === "" && files.length === 0) return { view: null };
    return { view: projectReplyDraft(threadId, prior, { body: input.body, files, recipients: input.recipients, quote: input.quote, mentions: input.mentions }, now().toISOString()) };
  };
  const refusal = (error: InboxError) => ({ status: error.code.endsWith("_not_found") ? 404 : 422, body: { error: error.message, code: error.code, ...error.details } });

  /** The version there a Discard made now throws away (undefined: the one the write that left leaves there, set as it lands). */
  const discardBase = (record: HeldDraft | null, k: string, body: Body): string | null | undefined => {
    if (!record) return known.has(k) ? (known.get(k)?.updated_at ?? null) : typeof body.base === "string" || body.base === null ? body.base : undefined;
    if (record.sent) return undefined;
    if (record.next?.discard) return record.next.discard.base;
    if (record.next?.save) return typeof record.next.save.base === "string" ? record.next.save.base : null;
    if (record.conflict) return record.view?.updated_at ?? null;
    return undefined;
  };

  /**
   * Hold a save or a Discard for that machine: folded into what waits for the thread, and sent once it is back. `left`:
   * it already went there without an answer (it may have landed), so it goes again under its own key, never folded.
   */
  const hold = (peer: DraftPeer, threadId: string, deleting: boolean, body: Body, left = false): DraftAnswer => {
    const machine = peer.id;
    const k = key(machine, threadId);
    const record = held.get(k) ?? null;
    const prior = record ? record.view : (known.get(k) ?? null);
    const idempotency_key = keyOf(body);
    let view: InboxReplyDraft | null = null;
    let write: HeldDraftWrite;
    if (deleting) {
      const base = discardBase(record, k, body);
      write = { discard: { idempotency_key, ...(base !== undefined ? { base } : {}) } };
    } else {
      // A second window here a step behind the held draft is refused as that machine's store would refuse it. With
      // nothing held, that machine judges the save when it lands.
      const made = project(threadId, prior, body, record !== null);
      if ("refused" in made) return made.refused;
      view = made.view;
      write = { save: { ...body, idempotency_key } };
    }
    let next = left ? (record?.next ?? null) : fold(record?.next ?? null, write);
    if (next?.save && !left) {
      try {
        next = { ...next, save: aligned(next.save, view) };
      } catch (error) {
        if (!(error instanceof InboxError)) throw error;
        return refusal(error);
      }
    }
    // The person wrote again: words a conflict offered, a "Not saved", a Send's wait are settled by it.
    put({ v: 1, machine, thread_id: threadId, view, sent: left ? write : (record?.sent ?? null), next, ...(record?.sending ? { sending: record.sending } : {}) });
    changed(machine, threadId);
    if (peer.state === "online") void drain(machine);
    else peer.poke();
    return deleting ? { status: 200, body: { ok: true, deleted: prior !== null } } : { status: 200, body: { draft: view } };
  };

  /** Discard mine, after a conflict a held save met there: its words go; that machine's draft stays. */
  const dropConflict = (machine: string, threadId: string, version: unknown): DraftAnswer => {
    const record = held.get(key(machine, threadId));
    if (record?.conflict && record.conflict.updated_at === version) {
      const { conflict: _gone, ...rest } = record;
      if (waits(record)) put(rest);
      else drop(machine, threadId);
      changed(machine, threadId);
    }
    return { status: 200, body: { ok: true, deleted: false } };
  };

  /** A save or a Discard from the window. */
  const write = async (peer: DraftPeer, threadId: string, deleting: boolean, body: Body, signal?: AbortSignal): Promise<DraftAnswer> => {
    if (deleting && typeof body.not_landed === "string") return dropConflict(peer.id, threadId, body.not_landed);
    const { not_landed: _notLanded, ...rest } = body;
    let sent: Body = { ...rest, idempotency_key: keyOf(rest) };
    const record = held.get(key(peer.id, threadId));
    // Nothing waits for this thread and that machine is there: its answer is the window's, a conflict included.
    if ((!record || !waits(record)) && peer.state === "online") {
      let left = false;
      try {
        const send = () => {
          left = true;
          return peer.request(`threads/${threadId}/draft${deleting ? "/delete" : ""}`, "", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(deleting ? { idempotency_key: sent.idempotency_key } : sent),
            signal,
            timeoutMs: DRAFT_WAIT_MS,
          });
        };
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
          // Landed: words a conflict offered here were the person's to settle, and they wrote again.
          if (far.ok && record) {
            drop(peer.id, threadId);
            changed(peer.id, threadId);
          }
          void noteAnswer(peer.id, threadId, deleting, far.clone());
          return { far };
        }
        await far.body?.cancel().catch(() => {});
      } catch {
        // Not there after all, or too slow. One that left may have landed there: it goes again under its own key (that
        // machine's door answers a key it saw once), never folded into a later save as new.
      }
      return hold(peer, threadId, deleting, sent, left);
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

  /**
   * A held save met a newer draft there (`far`; null: discarded there meanwhile). The person's words (`mine`, the
   * newest shown here) are never joined to it by themselves: words there discarded stay gone and these become the
   * draft; the same words (or none) go on that draft, their files added; otherwise that draft shows and these are
   * offered as a conflict is, until the person chooses.
   */
  const met = (current: HeldDraft, far: InboxReplyDraft | null, mine: InboxReplyDraft): HeldDraft => {
    if (!far) return { ...current, sent: null, next: { save: saveOf(mine, null) }, stopped: undefined };
    if (mine.body.trim() === "" || mine.body === far.body) return { ...current, sent: null, next: { save: saveOf(mine, far, mine.body.trim() === "" ? far.body : mine.body) }, stopped: undefined };
    return { ...current, view: far, sent: null, next: null, stopped: undefined, conflict: mine };
  };

  /** A reply that carried the draft is delivered there (it settles as that machine settles it) or not (its words come back). */
  const settleSend = (peer: DraftPeer, record: HeldDraft, delivered: boolean) => {
    const sending = record.sending!;
    const { sending: _done, ...rest } = record;
    // Unchanged since the Send: the person typed nothing after it.
    const untouched = (record.view?.updated_at ?? null) === sending.after;
    if (!delivered) {
      put(untouched ? { ...rest, view: sending.before } : rest);
      return changed(peer.id, record.thread_id);
    }
    put(rest);
    if (!untouched || !sending.before) return;
    const after = settleReplyDraftAfterSend(sending.before, { clearDraft: sending.clear_draft, words: sending.words, uploads: sending.uploads });
    if (after.kind === "delete") hold(peer, record.thread_id, true, {});
    else if (after.kind === "files") {
      const left = new Set(after.files.map((file) => file.upload_id));
      const view = rest.view;
      const remove = (sending.before.files ?? []).filter((file) => !left.has(file.upload_id)).map((file) => file.upload_id);
      const place = after.files.flatMap((file) => (file.pasted ? [{ upload_id: file.upload_id, pasted: file.pasted }] : []));
      hold(peer, record.thread_id, false, { body: "", base: view?.updated_at ?? null, base_body: view?.body ?? null, files_add: [], files_remove: remove, files_place: place, recipients: [] });
    }
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
      if (record.sending) {
        // A reply carrying this draft waits in the outbox: the draft lands after it, once it is delivered or refused.
        const state = options.replyState?.(record.sending.key) ?? "delivered";
        if (state === "pending") return true;
        settleSend(peer, record, state === "delivered");
        continue;
      }
      if (!record.sent) {
        if (!record.next) {
          // Words a conflict offers stay until the person chooses.
          if (record.conflict) return true;
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
        const { base } = write.discard;
        const answer = await post(peer, threadId, true, { idempotency_key: write.discard.idempotency_key, ...(base !== undefined ? { base } : {}) });
        if (!answer) return false;
        const latest = held.get(k);
        if (!latest) return true;
        if (codeOf(answer.body) === "draft_conflict") {
          // Changed there since the person threw it away (newer words typed there): it stays, and every window shows it.
          // A save behind the Discard stands on no draft, so it meets that one as a conflict (or lands beside it).
          known.set(k, draftOf(answer.body));
          put({ ...latest, sent: write.save ? { save: write.save } : null });
          changed(peer.id, threadId);
          continue;
        }
        // Gone there (or nothing to go): the save behind it, if any, stands on no draft; a Discard behind, on none.
        known.set(k, null);
        const next = latest.next?.discard && latest.next.discard.base === undefined ? { ...latest.next, discard: { ...latest.next.discard, base: null } } : latest.next;
        put({ ...latest, sent: write.save ? { save: write.save } : null, next });
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
        const behind = current.next;
        const next = behind?.save && !behind.discard
          ? { ...behind, save: { ...behind.save, base: landed?.updated_at ?? null, base_body: landed?.body ?? null, base_files: null } }
          : behind?.discard && behind.discard.base === undefined
            ? { ...behind, discard: { ...behind.discard, base: landed?.updated_at ?? null } }
            : behind;
        put({ ...current, sent: null, next });
        continue;
      }
      if (codeOf(answer.body) === "draft_conflict") {
        const far = draftOf(answer.body);
        known.set(k, far);
        if (!current.view) {
          // A Discard waits behind it: the person threw these words away. It goes only for the draft they saw, so the
          // newer one there stays.
          const behind = current.next?.discard && current.next.discard.base === undefined ? { ...current.next, discard: { ...current.next.discard, base: typeof save.base === "string" ? save.base : null } } : current.next;
          put({ ...current, sent: null, next: behind });
          continue;
        }
        put(met(current, far, current.view));
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
      // Any other refusal keeps the words: shown here as not saved there, and carried by the thread's next write
      // (`hold`). A Discard made meanwhile still goes.
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
          try {
            if (!(await land(peer, record.thread_id))) ok = false;
          } catch (error) {
            // A full disk, or anything else: the held file stays as it was, and it is tried again later.
            ok = false;
            if (!failedOnce) log(`Plannotator Inbox: a held reply draft for another computer could not be sent yet (${error instanceof Error ? error.message : String(error)}); trying again.`);
            failedOnce = true;
          }
        }
      } while (again.has(machine));
      retryLater(machine, ok);
    })()
      .catch(() => {})
      .finally(() => draining.delete(machine));
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
    /**
     * A read of the thread's draft this Inbox answers itself: the one held here, or (away) the last one heard, with
     * words of the person's the draft does not hold (`not_landed`). Null: ask that machine (`notLanded` adds them).
     */
    read(peer: DraftPeer, threadId: string): { draft: InboxReplyDraft | null; not_landed?: DraftNotLanded } | null {
      const k = key(peer.id, threadId);
      const record = held.get(k);
      const heard = known.get(k);
      if (record && (waits(record) || peer.state !== "online")) {
        const offered = notLandedOf(record);
        return { draft: waits(record) ? record.view : heard !== undefined ? heard : record.view, ...(offered ? { not_landed: offered } : {}) };
      }
      if (record) return null;
      return peer.state !== "online" && heard !== undefined ? { draft: heard } : null;
    },
    /** Words of the person's that the draft there does not hold, for a read that machine answered. */
    notLanded(machine: string, threadId: string): DraftNotLanded | null {
      return notLandedOf(held.get(key(machine, threadId)));
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
     * A reply held for that machine carried the draft (`clear_draft`, outbox key `replyKey`): the draft held here shows
     * what the Send leaves (`settleReplyDraftAfterSend`: gone, or its files the Send did not carry), so the sent words
     * never come back while it waits. It settles once the reply is delivered there; refused, its words are the draft again.
     */
    afterReply(peer: DraftPeer, threadId: string, body: Body, replyKey: string): void {
      const record = held.get(key(peer.id, threadId));
      const view = record?.view;
      if (!record || !view || typeof body.clear_draft !== "string") return;
      const uploadsSent = strings(body.uploads);
      const wordsSent = typeof body.words === "string" ? body.words : undefined;
      const after = settleReplyDraftAfterSend(view, { clearDraft: body.clear_draft, words: wordsSent, uploads: uploadsSent });
      if (after.kind === "unchanged") return;
      const shown = after.kind === "delete" ? null : projectReplyDraft(threadId, view, { body: "", files: after.files, mentions: [] }, now().toISOString());
      put({ ...record, view: shown, sending: { key: replyKey, before: view, after: shown?.updated_at ?? null, clear_draft: body.clear_draft, ...(wordsSent !== undefined ? { words: wordsSent } : {}), uploads: uploadsSent } });
      changed(peer.id, threadId);
    },
    /** A reply held for that machine was delivered there, refused or cancelled: a draft it carried settles, or comes back. */
    replySettled(machine: string, replyKey: string): void {
      const record = [...held.values()].find((r) => r.machine === machine && r.sending?.key === replyKey);
      const peer = options.peer(machine);
      const state = options.replyState?.(replyKey) ?? "pending";
      if (!record || !peer || state === "pending") return;
      try {
        settleSend(peer, record, state === "delivered");
      } catch {
        // A full disk: settled when it lands (`land` asks again).
      }
      if (peer.state === "online") void drain(machine);
    },
    /** That machine's rows, each with the Draft mark of a draft held here for it. */
    overlay<R extends InboxListRow & { machine: string }>(rows: readonly R[]): R[] {
      if (held.size === 0) return [...rows];
      return rows.map((row) => {
        const record = held.get(key(row.machine, row.thread_id));
        if (!record) return row;
        const unsent = { ...(row.unsent ?? { reply_at: null, picks: 0, comments: 0 }), reply_at: record.view ? record.view.updated_at : (record.conflict?.updated_at ?? null) };
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
          let draft: InboxReplyDraft | null | undefined = record ? (record.view ?? record.conflict ?? null) : undefined;
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
     * That machine is no longer linked: what is held for it goes. Each draft whose words did not land there (the one
     * shown while it waits, words a conflict offers, a Send's words not delivered), for the "Not sent" list (as a write
     * that was waiting for it): every word, its files' names and its quote, so it can still be copied.
     */
    forget(machine: string): LostDraft[] {
      const lost: LostDraft[] = [];
      const add = (thread: string, draft: InboxReplyDraft | null | undefined) => {
        if (!draft) return;
        const files = (draft.files ?? []).map((file) => file.name);
        if (draft.body.trim() === "" && files.length === 0) return;
        if (lost.some((one) => one.thread === thread && one.words === draft.body)) return;
        lost.push({ thread, words: draft.body, files, quote: draft.quote ?? null });
      };
      for (const record of [...held.values()]) {
        if (record.machine !== machine) continue;
        if (waits(record)) add(record.thread_id, record.view);
        add(record.thread_id, record.conflict);
        add(record.thread_id, record.sending?.before);
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
