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
import type { OutboxState } from "./inbox-outbox";

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
  /** Its name as its link says it (for "Not sent"). */
  readonly name?: string;
  state: string;
  list: { marks: readonly string[]; rows: readonly (InboxListRow & { machine: string })[] } | null;
  /** Reads of its list started so far, and which of them made the list held now (inbox-peer-link.ts). */
  listAsked: number;
  listGen: number;
  request(route: string, search: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<Response>;
  poke(): void;
  refreshList(): Promise<unknown>;
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
  /** Files of the person's a held save added that the draft there did not take (swept there since): not attached. */
  files?: InboxDraftFile[];
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

/** A draft's words as "Not sent" keeps them: every word, its files' names, its quote (null: nothing to keep). */
const lostOf = (thread: string, draft: Pick<InboxReplyDraft, "body" | "files" | "quote"> | null | undefined): LostDraft | null => {
  if (!draft) return null;
  const files = (draft.files ?? []).map((file) => file.name);
  if (draft.body.trim() === "" && files.length === 0) return null;
  return { thread, words: draft.body, files, quote: draft.quote ?? null };
};

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
/** A Discard refused there whose draft is the words thrown away (`baseBody`), under a newer version: that version (else null). */
const rebased = (answer: { status: number; body: unknown }, baseBody: unknown): string | null => {
  if (typeof baseBody !== "string" || codeOf(answer.body) !== "draft_conflict") return null;
  const there = draftOf(answer.body);
  return there && there.body === baseBody ? there.updated_at : null;
};
const draftOf = (answer: unknown): InboxReplyDraft | null => {
  const draft = answer && typeof answer === "object" ? (answer as { draft?: unknown }).draft : null;
  return draft && typeof draft === "object" && typeof (draft as InboxReplyDraft).body === "string" ? (draft as InboxReplyDraft) : null;
};
const keyOf = (body: Body) => (typeof body.idempotency_key === "string" && body.idempotency_key.trim() ? body.idempotency_key.trim() : crypto.randomUUID());
/** A held write still to go there (as opposed to a record that only offers words that did not land). */
const waits = (record: HeldDraft) => record.sent !== null || record.next !== null || !!record.stopped || !!record.sending;
/**
 * Words a conflict offers that stay offered beside `draft`: they go only by the person's choice in some window (Keep
 * mine saves them, Discard mine names them), or once the draft is those very words (never merely containing them: a
 * short "ok" is not settled by any draft that has it). Another window's write never settles them.
 */
const stillOffered = (record: HeldDraft | null | undefined, draft: InboxReplyDraft | null): Offered =>
  offeredAs(offeredOf(record).filter((one) => !sameWords(draft, one)));
const sameWords = (draft: InboxReplyDraft | null | undefined, one: InboxReplyDraft) => (draft?.body ?? "").trim() === one.body.trim();
/** At most this many sets of words wait behind the one offered now: past it, a new one takes the newest's place. */
export const MORE_OFFERED_MAX = 8;
type Offered = { conflict?: InboxReplyDraft; more?: InboxReplyDraft[] };
/** Every set of words a held record offers, oldest first: the one a read offers now (`conflict`), then those after it. */
const offeredOf = (record: HeldDraft | null | undefined): InboxReplyDraft[] => (record?.conflict ? [record.conflict, ...(record.more ?? [])] : []);
const offeredAs = (list: readonly InboxReplyDraft[]): Offered => (list.length === 0 ? {} : { conflict: list[0], ...(list.length > 1 ? { more: list.slice(1) } : {}) });
/** The record with no offered words of its own (they are given again by `offeredAs`). */
const unoffered = (record: HeldDraft): HeldDraft => {
  const { conflict: _conflict, more: _more, ...rest } = record;
  return rest;
};
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

/** What was folded behind a write that landed, standing on the draft there (its time and words), as a window's next save would. */
const standingOn = (behind: HeldDraftWrite | null, landed: InboxReplyDraft | null): HeldDraftWrite | null =>
  behind?.save && !behind.discard
    ? { ...behind, save: { ...behind.save, base: landed?.updated_at ?? null, base_body: landed?.body ?? null, base_files: null } }
    : behind?.discard && behind.discard.base === undefined
      ? { ...behind, discard: { ...behind.discard, base: landed?.updated_at ?? null } }
      : behind;

/** A held write without the files a delivered reply carried: they are its attachments there now, in no draft. */
const withoutSentFiles = (write: HeldDraftWrite | null, sentIds: readonly string[]): HeldDraftWrite | null => {
  if (!write?.save || sentIds.length === 0) return write;
  const sent = new Set(sentIds);
  const keep = (value: unknown) => refs(value).filter((ref) => !sent.has(ref.upload_id));
  const save: Body = { ...write.save };
  for (const field of ["files_add", "files_place", "files"] as const) if (Array.isArray(save[field])) save[field] = keep(save[field]);
  return { ...write, save };
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

/**
 * How a reply held for that machine stands, from its outbox entry's state (`replyState`). No entry: it settled long
 * ago and was dropped past its keep (inbox-outbox.ts `OUTBOX_KEEP_SETTLED_MS`): delivered, or refused and its line
 * dismissed. Never read as refused: words already sent there must not come back as the draft.
 */
export function heldReplyState(state: OutboxState | undefined): "pending" | "delivered" | "refused" {
  if (state === undefined || state === "delivered") return "delivered";
  return state === "refused" || state === "dropped" || state === "cancelled" ? "refused" : "pending";
}

export function createMachineDrafts(options: {
  dataDir: string;
  /** A thread's draft changed as this Inbox shows it: every window's stream says `event: drafts`. */
  onChange: (machine: string, threadId: string) => void;
  /** The machine's line: its state, its door, and its list to read again once a held draft landed there. */
  peer: (machine: string) => DraftPeer | undefined;
  /** How a reply held for that machine stands (its outbox key): a draft it carried settles once it is delivered. */
  replyState?: (key: string) => "pending" | "delivered" | "refused";
  /**
   * Words saved for a machine whose link went while the save was on its way (Unlink ran meanwhile): they go to "Not
   * sent" here (inbox-machines.ts), as `forget` hands back what was held. Nothing is held for that machine any more.
   */
  lost?: (peer: DraftPeer, lost: LostDraft) => void;
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
  /**
   * Each far draft as this Inbox last heard it there (null: none), with how many reads of that machine's list had
   * started then (`asked`): a list read started later says what is there now. Absent: not heard since this Inbox started.
   */
  const known = new Map<string, { draft: InboxReplyDraft | null; asked: number }>();
  const machineOf = (k: string) => k.slice(0, k.indexOf(" "));
  const heard = (k: string) => known.get(k)?.draft;
  /**
   * Far drafts last heard that that machine has since said moved on (its stream said the draft changed, and its list,
   * read again for it, names another version or none): sent, discarded or written over there. While it is away, a
   * read here shows no draft rather than words that may be sent already (`read`).
   */
  const movedOn = new Set<string>();
  const hear = (k: string, draft: InboxReplyDraft | null) => {
    known.set(k, { draft, asked: options.peer(machineOf(k))?.listAsked ?? 0 });
    movedOn.delete(k);
  };
  /** The version of the far draft last heard (null: none, or none heard). */
  const heardAt = (k: string) => heard(k)?.updated_at ?? null;
  /** The thread's held record is what this Inbox shows for it: words to land, or offered words a person must settle. */
  const shows = (record: HeldDraft | null | undefined): boolean => !!record && (waits(record) || !!record.conflict);
  const uploads = new Map<string, InboxUpload>();
  const draining = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const retries = new Map<string, { timer: ReturnType<typeof setTimeout> | null; ms: number }>();
  /**
   * Per thread: the draft a held save made there as it landed (`there`), and the version this Inbox showed for it while
   * it was held (`here`, the `base` a window that saw it names): a Discard naming `here` goes for `there`.
   */
  const landedAs = new Map<string, { here: string; there: string }>();
  let failedOnce = false;

  /**
   * Written to disk first: memory follows only once the file holds it (a full disk leaves both as they were). Never for
   * a machine that is not linked (its link went while a write was on its way): nothing is held for it after `forget`.
   */
  const put = (record: HeldDraft) => {
    if (!options.peer(record.machine)) return;
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
    const files = record?.gone?.length ? { files: record.gone } : {};
    if (record?.conflict) return { words: record.conflict.body, version: record.conflict.updated_at, conflict: true, ...files };
    if (record?.stopped && record.view && record.view.body.trim() !== "") return { words: record.view.body, version: record.view.updated_at, ...files };
    if (record?.gone?.length) return { words: "", version: record.view?.updated_at ?? "", ...files };
    return null;
  };
  /**
   * The files `save` added (its `files_add`, or an older page's whole list) that the draft it made there does not hold:
   * that machine skips an added file whose upload it swept since. Named as this Inbox knew them, beside any found before.
   */
  const goneAfter = (save: Body, landed: InboxReplyDraft | null, record: HeldDraft): InboxDraftFile[] => {
    const there = new Set((landed?.files ?? []).map((file) => file.upload_id));
    const added = [...refs(save.files_add), ...refs(save.files)].filter((ref) => !there.has(ref.upload_id));
    const was = (record.gone ?? []).filter((file) => !there.has(file.upload_id) && !added.some((ref) => ref.upload_id === file.upload_id));
    const named = added.flatMap((ref): InboxDraftFile[] => {
      const known = record.view?.files?.find((file) => file.upload_id === ref.upload_id) ?? uploads.get(ref.upload_id);
      if (!known) return [];
      const { pasted: _pasted, ...upload } = known as InboxDraftFile;
      return [{ ...upload, ...(ref.pasted ? { pasted: ref.pasted } : {}) }];
    });
    return [...was, ...named];
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

  /**
   * The version there a Discard made now throws away (undefined: the one the write that left leaves there, set as it
   * lands). With nothing waiting here, the one the window names (`base`): never a newer one heard there since, which
   * that window never showed. Only an older page, naming none, goes for the last one heard.
   */
  const discardBase = (record: HeldDraft | null, k: string, body: Body): string | null | undefined => {
    if (record && waits(record)) {
      if (record.sent) return undefined;
      if (record.next?.discard) return record.next.discard.base;
      if (record.next?.save) return typeof record.next.save.base === "string" ? record.next.save.base : null;
      if (record.conflict) return record.view?.updated_at ?? null;
      return undefined;
    }
    if (typeof body.base === "string" || body.base === null) {
      const was = landedAs.get(k);
      return was && body.base === was.here ? was.there : body.base;
    }
    if (record?.conflict) return record.view?.updated_at ?? null;
    return known.has(k) ? heardAt(k) : undefined;
  };

  /**
   * Hold a save or a Discard for that machine: folded into what waits for the thread, and sent once it is back. `left`:
   * it already went there without an answer (it may have landed), so it goes again under its own key, never folded.
   */
  const hold = (peer: DraftPeer, threadId: string, deleting: boolean, body: Body, left = false): DraftAnswer => {
    const machine = peer.id;
    // Its link went while this write was on its way (Unlink ran meanwhile): nothing is held for it. A save's words go to
    // "Not sent" (`lost`), as `forget` handed back the rest; a Discard has none to keep. A link replaced by a new one to
    // the same machine (rule 19) is still linked: the write is held for it as ever.
    if (!options.peer(machine)) {
      if (!deleting) {
        const made = project(threadId, null, body, false);
        const gone = lostOf(threadId, "view" in made ? made.view : ({ body: words(body) } as InboxReplyDraft));
        if (gone) options.lost?.(peer, gone);
      }
      return { status: 404, body: { error: "That machine is not linked.", code: "machine_not_linked" } };
    }
    const k = key(machine, threadId);
    const record = held.get(k) ?? null;
    // The draft it stands on: the one held here while it waits (or beside offered words), else the one last heard there
    // (a record only naming files a landed save could not keep holds no draft of its own).
    const prior = record && shows(record) ? record.view : (heard(k) ?? record?.view ?? null);
    const idempotency_key = keyOf(body);
    let view: InboxReplyDraft | null = null;
    let write: HeldDraftWrite;
    if (deleting) {
      const base = discardBase(record, k, body);
      write = { discard: { idempotency_key, ...(base !== undefined ? { base } : {}), ...(typeof body.base_body === "string" ? { base_body: body.base_body } : {}) } };
    } else {
      // A second window here a step behind the held draft is refused as that machine's store would refuse it. With
      // nothing held, that machine judges the save when it lands.
      const made = project(threadId, prior, body, shows(record));
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
    // The person wrote again: a "Not saved", a Send's wait are settled by it. Words a conflict offers stay until chosen.
    put({ v: 1, machine, thread_id: threadId, view, sent: left ? write : (record?.sent ?? null), next, ...(record?.sending ? { sending: record.sending } : {}), ...stillOffered(record, view) });
    changed(machine, threadId);
    if (peer.state === "online") void drain(machine);
    else peer.poke();
    return deleting ? { status: 200, body: { ok: true, deleted: prior !== null } } : { status: 200, body: { draft: view } };
  };

  /**
   * Discard mine, after a conflict a held save met there: the words of that version go (any others offered stay, the
   * next of them offered now); that machine's draft stays.
   */
  const dropConflict = (machine: string, threadId: string, version: unknown): DraftAnswer => {
    const record = held.get(key(machine, threadId));
    const offered = offeredOf(record);
    if (record && offered.some((one) => one.updated_at === version)) {
      const left = offered.filter((one) => one.updated_at !== version);
      if (left.length > 0 || waits(record) || record.gone) put({ ...unoffered(record), ...offeredAs(left) });
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
    const k = key(peer.id, threadId);
    const record = held.get(k);
    // Nothing waits for this thread and that machine is there: its answer is the window's, a conflict included.
    if ((!record || !waits(record)) && peer.state === "online") {
      let left = false;
      // A Discard goes only for the version the window threw away: one changed there since is refused there, and stays.
      let base = deleting ? discardBase(record ?? null, k, rest) : undefined;
      try {
        const send = () => {
          left = true;
          return peer.request(`threads/${threadId}/draft${deleting ? "/delete" : ""}`, "", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // A Discard always names the version it throws away (that door requires it): null when none is known here,
            // so it never deletes a draft this Inbox never showed.
            body: JSON.stringify(deleting ? { idempotency_key: sent.idempotency_key, base: base ?? null } : sent),
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
        // Refused, but the draft there is the words thrown away under a newer version (the save they came with was still
        // on its way, or landed while held by an earlier run of this Inbox): those go.
        const thrown = deleting && far.status === 409 ? rebased({ status: 409, body: await far.clone().json().catch(() => null) }, rest.base_body) : null;
        if (thrown !== null) {
          await far.body?.cancel().catch(() => {});
          base = thrown;
          sent = { ...sent, idempotency_key: crypto.randomUUID() };
          far = await send();
        }
        if (far.status < 500) {
          // Landed: what was held here is settled, but words a conflict offers stay until the person chooses (a window
          // that never showed them saved). Read again after the wait: what was held meanwhile (another window's save
          // as that machine stopped answering, a Send's mark) stays, to land after this.
          const landed = far.ok && !deleting ? draftOf(await far.clone().json().catch(() => null)) : null;
          const latest = held.get(k);
          if (far.ok && latest) {
            const offered = stillOffered(latest, landed);
            if (latest !== record && waits(latest)) put({ ...unoffered(latest), ...offered });
            else if (offered.conflict) put({ v: 1, machine: peer.id, thread_id: threadId, view: landed, sent: null, next: null, ...offered });
            else drop(peer.id, threadId);
            changed(peer.id, threadId);
          }
          // A Discard refused there (the draft changed there since): it stays, and every window shows it.
          if (deleting && far.status === 409) changed(peer.id, threadId);
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
    if (answer.ok) hear(key(machine, threadId), deleting ? null : draftOf(body));
    else if (codeOf(body) === "draft_conflict") hear(key(machine, threadId), draftOf(body));
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
    // Words offered before and not chosen on yet stay offered, first: these are offered after them (words these or that
    // draft hold are offered by them).
    const before = offeredOf(current).filter((one) => !sameWords(mine, one) && !sameWords(far, one));
    // Bounded: the oldest stay; past the cap a new one takes the newest's place.
    const list = before.length > MORE_OFFERED_MAX ? [...before.slice(0, MORE_OFFERED_MAX), mine] : [...before, mine];
    return { ...unoffered(current), view: far, sent: null, next: null, stopped: undefined, ...offeredAs(list) };
  };

  /** A reply that carried the draft is delivered there (it settles as that machine settles it) or not (its words come back). */
  const settleSend = (peer: DraftPeer, record: HeldDraft, delivered: boolean) => {
    const sending = record.sending!;
    const { sending: _done, ...rest } = record;
    // Unchanged since the Send: the person typed nothing after it.
    const untouched = (record.view?.updated_at ?? null) === sending.after;
    if (!delivered) {
      // Refused: its words come back, once: the draft it held, and words a conflict offered that it carried, offered again.
      const back = sending.offered ? { ...unoffered(rest), ...offeredAs([...sending.offered, ...offeredOf(rest)]) } : rest;
      put(untouched ? { ...back, view: sending.before } : back);
      return changed(peer.id, record.thread_id);
    }
    // Delivered: a save still held from before the Send (words typed after it fold onto it) no longer adds the files
    // the reply carried, so the next draft never names them as files that could not be added.
    put({ ...rest, sent: withoutSentFiles(rest.sent, sending.uploads), next: withoutSentFiles(rest.next, sending.uploads) });
    if (!untouched || !sending.before) return;
    const after = settleReplyDraftAfterSend(sending.before, { clearDraft: sending.clear_draft, words: sending.words, uploads: sending.uploads });
    // Only the version it carried goes (newer words typed there since stay).
    if (after.kind === "delete") hold(peer, record.thread_id, true, { base: sending.before.updated_at });
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
      // Landed, its files not taken there said on their tiles: nothing left to send.
      if (record.gone && !waits(record)) return true;
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
        // Its version, else (none set as the write before it landed) the one last heard there, else none: always named.
        const base = write.discard.base !== undefined ? write.discard.base : heardAt(k);
        let answer = await post(peer, threadId, true, { idempotency_key: write.discard.idempotency_key, base });
        if (!answer) return false;
        // Refused, but the draft there is the words thrown away under a newer version (the save they came with landed
        // after, or an earlier run of this Inbox landed it): those go.
        const thrown = rebased(answer, write.discard.base_body);
        if (thrown !== null) answer = await post(peer, threadId, true, { idempotency_key: crypto.randomUUID(), base: thrown });
        if (!answer) return false;
        const latest = held.get(k);
        if (!latest) return true;
        if (codeOf(answer.body) === "draft_conflict") {
          // Changed there since the person threw it away (newer words typed there): it stays, and every window shows it.
          // A save behind the Discard stands on no draft, so it meets that one as a conflict (or lands beside it).
          hear(k, draftOf(answer.body));
          put({ ...latest, sent: write.save ? { save: write.save } : null });
          changed(peer.id, threadId);
          continue;
        }
        // Gone there (or nothing to go): the save behind it, if any, stands on no draft; a Discard behind, on none.
        hear(k, null);
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
        hear(k, landed);
        const next = standingOn(current.next, landed);
        // A file it added that machine swept since is not in the draft there: never dropped unsaid, its tile says so.
        const gone = goneAfter(save, landed, current);
        const { gone: _was, ...rest } = current;
        // The draft the windows were shown while it waited is this one there now: a Discard naming it goes for this.
        if (!next && current.view && landed) landedAs.set(k, { here: current.view.updated_at, there: landed.updated_at });
        // Nothing left to send but the files it could not add: the record keeps their names only, never the draft's words
        // (that draft is there, read from there; held here it would outlive a Send or a Discard there). Beside offered
        // words it is the draft they are offered against, as `met` leaves it.
        put({ ...rest, sent: null, next, ...(gone.length > 0 ? { gone, ...(next ? {} : { view: rest.conflict ? landed : null }) } : {}) });
        if (gone.length > 0 && !next) {
          await peer.refreshList().catch(() => {});
          changed(peer.id, threadId);
          return true;
        }
        continue;
      }
      if (codeOf(answer.body) === "draft_conflict") {
        const far = draftOf(answer.body);
        hear(k, far);
        if (far && far.body === words(save)) {
          // Its words are the draft there, under a newer version: it landed and that draft changed there since (a window
          // there took a file out, changed the quote or the recipients: a replay under its key alone is answered by the
          // store, `last_key`), or the same words were typed there. That draft is the newer one and stays as it is: this
          // save is never sent again over it (nor offered as a conflict with itself). What was folded behind stands on it.
          put({ ...current, sent: null, next: standingOn(current.next, far) });
          continue;
        }
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
        const lost = (view?.files ?? []).filter((file) => gone.has(file.upload_id) && !(current.gone ?? []).some((one) => one.upload_id === file.upload_id));
        if (view) {
          const { files: was, ...rest } = view;
          const files = (was ?? []).filter((file) => !gone.has(file.upload_id));
          view = { ...rest, ...(files.length > 0 ? { files } : {}) };
        }
        // Said on its tile, as one a save added that machine did not take (`goneAfter`).
        const said = [...(current.gone ?? []), ...lost];
        put({ ...current, view, sent: { save: again }, ...(said.length > 0 ? { gone: said } : {}) });
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
      if (peer.state !== "online" && !(record && waits(record))) {
        // Away, and the draft last heard has moved on there: none is shown (it may be sent already), and a save typed
        // now stands on none, as the window that reads this does. Words typed here and held stay as they are. Moved on:
        // its stream said so, or a list read started after it was heard (one at a reconnect, say) names another version.
        const was = known.get(k);
        const row = was && peer.listGen > was.asked ? peer.list?.rows.find((one) => one.thread_id === threadId) : undefined;
        if (movedOn.has(k) || (was && peer.listGen > was.asked && (row?.unsent?.reply_at ?? null) !== (was.draft?.updated_at ?? null))) hear(k, null);
      }
      const last = heard(k);
      if (record && (waits(record) || peer.state !== "online")) {
        const offered = notLandedOf(record);
        return { draft: waits(record) ? record.view : last !== undefined ? last : record.view, ...(offered ? { not_landed: offered } : {}) };
      }
      if (record) return null;
      return peer.state !== "online" && last !== undefined ? { draft: last } : null;
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
    /**
     * That machine said its draft changed (another window there, a phone, a Send, this Inbox's own write), its list read
     * again first: heard again on the next read. The last one heard stays meanwhile: a save held before that read
     * stands on it (its files, its quote), never on no draft; that machine judges it against its newer one as it lands.
     * Unless the list's row names that very version, it has moved on (`movedOn`): a read while that machine is away
     * shows no draft. `refreshed` false: the list could not be read again, so it may have moved on: it has. A row that
     * says no draft there (sent or discarded) also ends the names of files a landed save could not keep (`gone`).
     */
    farChanged(machine: string, threadId: string, refreshed = true): void {
      const k = key(machine, threadId);
      const row = refreshed ? options.peer(machine)?.list?.rows.find((one) => one.thread_id === threadId) : undefined;
      const record = held.get(k);
      if (record?.gone && row && (row.unsent?.reply_at ?? null) === null) {
        const { gone: _gone, ...rest } = record;
        if (shows(rest)) put(rest);
        else drop(machine, threadId);
      }
      if (!known.has(k)) return;
      if (!row || (row.unsent?.reply_at ?? null) !== heardAt(k)) movedOn.add(k);
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
      if (typeof body.clear_draft !== "string") return;
      const k = key(peer.id, threadId);
      const record = held.get(k) ?? null;
      // The draft shown here: the one held while it waits, else the one last heard there (a Send while that machine
      // sleeps, or before a window reads it again, must not bring the sent words back from it).
      const view = record && waits(record) ? record.view : known.has(k) ? (heard(k) ?? null) : (record?.view ?? null);
      const uploadsSent = strings(body.uploads);
      const wordsSent = typeof body.words === "string" ? body.words : undefined;
      const sentAs = { clearDraft: body.clear_draft, words: wordsSent, uploads: uploadsSent };
      const after = view ? settleReplyDraftAfterSend(view, sentAs) : ({ kind: "unchanged" } as const);
      // Words a conflict offered that this reply carries: no longer offered (never sent twice), back if it is refused.
      const offered = offeredOf(record);
      const carried = offered.filter((one) => settleReplyDraftAfterSend(one, sentAs).kind !== "unchanged");
      if (after.kind === "unchanged" && carried.length === 0) return;
      const shown = after.kind === "unchanged" ? view : after.kind === "delete" ? null : projectReplyDraft(threadId, view, { body: "", files: after.files, mentions: [] }, now().toISOString());
      const base: HeldDraft = record ? unoffered(record) : { v: 1, machine: peer.id, thread_id: threadId, view: null, sent: null, next: null };
      put({
        ...base,
        view: shown,
        ...offeredAs(offered.filter((one) => !carried.includes(one))),
        sending: { key: replyKey, before: view, after: shown?.updated_at ?? null, clear_draft: body.clear_draft, ...(wordsSent !== undefined ? { words: wordsSent } : {}), uploads: uploadsSent, ...(carried.length > 0 ? { offered: carried } : {}) },
      });
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
    /**
     * That machine's rows, each with the Draft mark of a draft held here for it. A record that does not wait (offered
     * words, files a landed save could not keep) draws no version of its own: the row's, else the offered words'.
     */
    overlay<R extends InboxListRow & { machine: string }>(rows: readonly R[]): R[] {
      if (held.size === 0) return [...rows];
      return rows.map((row) => {
        const record = held.get(key(row.machine, row.thread_id));
        if (!record) return row;
        const reply_at = waits(record) ? (record.view?.updated_at ?? record.conflict?.updated_at ?? null) : (row.unsent?.reply_at ?? record.conflict?.updated_at ?? null);
        const unsent = { ...(row.unsent ?? { reply_at: null, picks: 0, comments: 0 }), reply_at };
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
          let draft: InboxReplyDraft | null | undefined = record && shows(record) ? (record.view ?? record.conflict ?? null) : undefined;
          if (draft === undefined) {
            const last = heard(key(peer.id, row.thread_id));
            if (last !== undefined && (last?.updated_at ?? null) === row.unsent!.reply_at) draft = last;
          }
          if (draft === undefined && row.unsent!.reply_at !== null && peer.state === "online") {
            const answer = await peer.request(`threads/${row.thread_id}/draft`, "", { method: "GET", headers: {}, timeoutMs: PREVIEW_WAIT_MS }).catch(() => null);
            const body = answer?.ok ? await answer.json().catch(() => null) : null;
            if (body) {
              draft = draftOf(body);
              hear(key(peer.id, row.thread_id), draft);
            }
          }
          return { ...row, reply_preview: replyDraftPreview(draft) };
        }),
      );
    },
    /** How many threads hold a draft here for that machine, not landed yet: Unlink says they would be lost. */
    heldCount(machine: string): number {
      return [...held.values()].filter((record) => record.machine === machine && (waits(record) || !!record.conflict || !!record.stopped)).length;
    },
    /**
     * That machine is no longer linked: what is held for it goes. Each draft whose words did not land there (the one
     * shown while it waits, words a conflict offers, a Send's words not delivered), for the "Not sent" list (as a write
     * that was waiting for it): every word, its files' names and its quote, so it can still be copied. `keepHeld`: the
     * files stay on disk (those words could not be put in "Not sent").
     */
    forget(machine: string, keepHeld = false): LostDraft[] {
      const lost: LostDraft[] = [];
      const add = (thread: string, draft: InboxReplyDraft | null | undefined) => {
        const one = lostOf(thread, draft);
        if (one && !lost.some((was) => was.thread === thread && was.words === one.words)) lost.push(one);
      };
      for (const record of [...held.values()]) {
        if (record.machine !== machine) continue;
        if (waits(record)) add(record.thread_id, record.view);
        for (const offered of offeredOf(record)) add(record.thread_id, offered);
        // Words a held reply carried are in "Not sent" as that reply (dropped with the link): never a second time here.
        if (!keepHeld) drop(machine, record.thread_id);
      }
      const retry = retries.get(machine);
      if (retry?.timer) clearTimeout(retry.timer);
      retries.delete(machine);
      for (const k of [...known.keys()]) if (k.startsWith(`${machine} `)) known.delete(k);
      for (const k of [...movedOn]) if (k.startsWith(`${machine} `)) movedOn.delete(k);
      for (const k of [...landedAs.keys()]) if (k.startsWith(`${machine} `)) landedAs.delete(k);
      return lost;
    },
  };
}

export type MachineDrafts = ReturnType<typeof createMachineDrafts>;
