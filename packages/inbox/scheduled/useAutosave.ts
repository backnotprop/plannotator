/**
 * The routine editor's saving (approval "inbox-routine-editor-autosave"). A field saves after a typing pause, when it
 * is left, at once for a pick, and with `keepalive` as the page hides or goes (pagehide, visibilitychange). Only what
 * differs from the server's is sent, and what the server answers is what it has: an answer older than one already in
 * (two writes in flight) is let go. A write that gets no answer, or a 5xx, is tried again with a growing pause and
 * the words stay in the field; a refusal (4xx) is said and waits for the next edit. An emptied name or prompt is not
 * sent (a routine needs both): the status says which is missing, and the field is never put back while typed in.
 *
 * A routine that is on runs what is saved, so its typed name and prompt are not saved on the typing pause, only when
 * the field is left, the editor goes, the page hides, or before Run once now or a turn ("Not saved yet" until then).
 *
 * A new routine is made once it has a name and a prompt, with one key for every try (the server answers a key's
 * routine again), and until then it is kept in the tab's sessionStorage (routineDraft.ts), as a saved one's edits not
 * saved yet are. The editor stays mounted when the new one takes its id (ScheduledPage), so words typed while it is
 * being made, and the cursor, stay.
 */
import { useEffect, useRef, useState } from 'react';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { InboxApiError } from '../apiError';
import { newUuid } from '../uuid';
import { scheduledApi, type ScheduledFields } from './client';
import { forgetKeptRoutine, keepEdits, keepRoutine, readKeptEdits, readKeptRoutine } from './routineDraft';
import { putScheduled } from './store';
import { routineOn } from './EditorFoot';

export const TYPING_PAUSE_MS = 600;
export const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export type SaveStatus =
  | { kind: 'new' | 'held' | 'saving' | 'saved' | 'failed' }
  | { kind: 'needs'; field: 'name' | 'prompt' }
  | { kind: 'refused'; message: string };

type Key = keyof ScheduledFields;

export const fieldsOf = (row: InboxScheduledRow): ScheduledFields => ({
  name: row.name,
  prompt: row.prompt,
  schedule: row.schedule,
  if_missed: row.if_missed,
  folder: row.folder,
  agent: row.agent,
  ...(row.model ? { model: row.model } : {}),
  ...(row.effort ? { effort: row.effort } : {}),
  attachments: row.attachments,
});

/** As the server keeps it: a name's spaces folded, a prompt trimmed. */
const norm = (key: Key, value: unknown) => (key === 'name' ? String(value ?? '').trim().replace(/\s+/g, ' ') : key === 'prompt' ? String(value ?? '').trim() : JSON.stringify(value ?? null));
const json = (value: unknown) => JSON.stringify(value ?? null);
const keysOf = (...all: Partial<ScheduledFields>[]) => [...new Set(all.flatMap((f) => Object.keys(f)))] as Key[];
const TYPED: Key[] = ['name', 'prompt'];
/** No answer at all (the fetch threw), or the Inbox failing or busy: worth another try. */
const retryable = (cause: unknown) => !(cause instanceof InboxApiError) || cause.status >= 500 || cause.status === 408 || cause.status === 429;

/** A saved routine's edits kept through a reload, over a field nobody else changed meanwhile. */
function withKept(id: string | null, fields: ScheduledFields): ScheduledFields {
  const kept = id ? readKeptEdits(id) : null;
  if (!kept) return fields;
  const next = { ...fields };
  for (const k of keysOf(kept.fields)) if (json(fields[k]) === json(kept.was[k])) Object.assign(next, { [k]: kept.fields[k] });
  return next;
}

export function useAutosave(opts: {
  id: string;
  record: InboxScheduledRow | null;
  /** A new one's fields before anything is typed. */
  fresh: () => ScheduledFields;
  /** A field not to send yet: a schedule the preview refused or has not answered. */
  held: (key: Key, fields: ScheduledFields) => boolean;
  /** It is on: a typed name or prompt waits for the field to be left, not the typing pause. */
  holdTyping: boolean;
  onCreated: (id: string) => void;
}) {
  const live = useRef(opts);
  live.current = opts;
  const madeAt = opts.id === 'new' ? null : opts.id;
  const kept = useRef(madeAt ? null : readKeptRoutine());
  const [draft, setDraftState] = useState<ScheduledFields>(() => (opts.record ? withKept(madeAt, fieldsOf(opts.record)) : (kept.current?.fields ?? opts.fresh())));
  const typed = useRef(draft);
  /** What the server has, as far as this window knows; null before a new one is made or a linked one is read. */
  const base = useRef<ScheduledFields | null>(opts.record ? fieldsOf(opts.record) : null);
  const lastAt = useRef(opts.record?.updated_at ?? '');
  const made = useRef<string | null>(madeAt);
  const createdHere = useRef(false);
  const key = useRef(kept.current?.key ?? newUuid());
  const wantOn = useRef(false);
  const busy = useRef<Promise<void> | null>(null);
  /** The writes on their way, by what they send: the same one is never sent twice at once. */
  const inflight = useRef(new Map<string, Promise<unknown>>());
  /** A save asked for while one is on its way: 'auto' on its own, 'asked' when a field was left or an action waits. */
  const again = useRef<false | 'auto' | 'asked'>(false);
  /** It is on, by the newest row this window has (a new one can come back on before its record is read). */
  const rowOn = useRef(routineOn(opts.record));
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tries = useRef(0);
  const gone = useRef(false);
  const dropped = useRef(false);
  const failed = useRef<{ retrying: boolean; message: string } | null>(null);
  const [, rerender] = useState(0);
  const redraw = () => !gone.current && rerender((n) => n + 1);
  const setFailure = (next: { retrying: boolean; message: string } | null) => {
    failed.current = next;
    redraw();
  };

  const missing = (fields: ScheduledFields) => !fields.name.trim() || !fields.prompt.trim();
  const heldAny = (fields: ScheduledFields) => keysOf(fields).some((k) => live.current.held(k, fields));
  /** An on routine's typed name and prompt wait for the field to be left. */
  const holding = () => !!made.current && (live.current.holdTyping || rowOn.current);
  /** What differs from the server's, less an emptied name or prompt and anything held (`auto`: an on one's typing). */
  const changes = (auto = false): Partial<ScheduledFields> => {
    const d = typed.current;
    const b = base.current;
    const out: Partial<ScheduledFields> = {};
    if (!b) return out;
    for (const k of keysOf(d, b)) {
      if (norm(k, d[k]) === norm(k, b[k])) continue;
      if ((k === 'name' || k === 'prompt') && !d[k].trim()) continue;
      if (live.current.held(k, d)) continue;
      if (auto && TYPED.includes(k) && holding()) continue;
      Object.assign(out, { [k]: d[k] });
    }
    return out;
  };
  /** Something to send. `auto`: on its own (after a save, on mount), so an on routine's typed words wait. */
  const work = (auto = false) => {
    if (dropped.current) return false;
    if (!made.current) return !missing(typed.current) && !heldAny(typed.current);
    return Object.keys(changes(auto)).length > 0 || wantOn.current;
  };
  /** The tab keeps what is not saved yet: a new one whole, a saved one's edits with what the server had. */
  const keepNow = () => {
    if (dropped.current) return;
    if (!made.current) return keepRoutine(typed.current, key.current);
    if (!base.current) return;
    const fields = changes();
    const was: Partial<ScheduledFields> = {};
    for (const k of keysOf(fields)) Object.assign(was, { [k]: base.current[k] });
    keepEdits(made.current, { fields, was });
  };
  const setDraft = (next: ScheduledFields) => {
    typed.current = next;
    setDraftState(next);
    keepNow();
  };
  /** The server's answer: what it has now, unless a newer answer is already in. */
  const accept = (row: InboxScheduledRow, sent: Partial<ScheduledFields>) => {
    if (row.updated_at < lastAt.current) return;
    lastAt.current = row.updated_at;
    rowOn.current = routineOn(row);
    const theirs = fieldsOf(row);
    base.current = theirs;
    // What the server keeps for what was sent (a folder by its path, say) is shown while the field is as it was sent.
    const next = { ...typed.current };
    let adopt = false;
    for (const k of keysOf(sent)) {
      if (json(typed.current[k]) === json(sent[k]) && norm(k, theirs[k]) !== norm(k, sent[k])) {
        Object.assign(next, { [k]: theirs[k] });
        adopt = true;
      }
    }
    if (adopt) setDraft(next);
    else keepNow();
    putScheduled(row);
  };
  /** One write, once: the same body on its way is waited for (or, as the page goes, left to land). */
  const once = async <T>(sig: string, keepalive: boolean, write: () => Promise<T>): Promise<T | null> => {
    const same = inflight.current.get(sig);
    if (same) {
      if (!keepalive) await same;
      return null;
    }
    const pending = write();
    inflight.current.set(sig, pending);
    try {
      return await pending;
    } finally {
      inflight.current.delete(sig);
    }
  };

  const send = async (keepalive: boolean, auto = false): Promise<void> => {
    if (dropped.current) return;
    const d = typed.current;
    if (!made.current) {
      if (missing(d) || heldAny(d)) return;
      const body = { ...d, ...(wantOn.current ? { enabled: true } : {}) };
      const answer = await once(`new ${json(body)}`, keepalive, () => scheduledApi.create(body, key.current, keepalive));
      // Answered already (the same create, or one that raced it with this key): one routine.
      if (!answer || made.current) return;
      if (dropped.current) {
        // Deleted while it was being made: it goes, as the person asked.
        forgetKeptRoutine();
        void scheduledApi.remove(answer.scheduled.id).catch(() => {});
        return;
      }
      made.current = answer.scheduled.id;
      createdHere.current = true;
      if (answer.scheduled.state !== 'off') wantOn.current = false;
      forgetKeptRoutine();
      accept(answer.scheduled, body);
      if (!gone.current) live.current.onCreated(answer.scheduled.id);
      return;
    }
    const id = made.current;
    const change = changes(auto);
    if (Object.keys(change).length > 0) {
      const answer = await once(`${id} ${json(change)}`, keepalive, () => scheduledApi.update(id, change, keepalive));
      if (answer) accept(answer.scheduled, change);
    }
    if (wantOn.current) {
      wantOn.current = false;
      const { scheduled } = await scheduledApi.turn(id, true);
      rowOn.current = routineOn(scheduled);
      putScheduled(scheduled);
    }
  };

  /** Save what waits. `auto` (the typing pause, the preview, a retry of one, on mount): an on one's typing stays. */
  const save = (auto: boolean) => {
    if (pause.current) clearTimeout(pause.current);
    pause.current = null;
    if (busy.current) {
      if (again.current !== 'asked') again.current = auto ? 'auto' : 'asked';
      return;
    }
    if (!work(auto)) return void redraw();
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    let fell = false;
    const run = send(false, auto).then(
      () => {
        tries.current = 0;
        if (failed.current) setFailure(null);
      },
      (cause: unknown) => {
        fell = true;
        if (gone.current) return;
        if (retryable(cause)) {
          retry.current = setTimeout(() => latest.current.save(auto), RETRY_MS[Math.min(tries.current++, RETRY_MS.length - 1)]);
          setFailure({ retrying: true, message: '' });
        } else setFailure({ retrying: false, message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
    busy.current = run;
    redraw();
    void run.finally(() => {
      busy.current = null;
      const more = again.current;
      again.current = false;
      if (!gone.current && !fell && (more || work(true))) save(more !== 'asked');
      else redraw();
    });
  };
  const flush = () => save(false);
  /** The page hides or goes: what waits is sent now and outlives the page. */
  const leave = () => {
    if (pause.current) clearTimeout(pause.current);
    pause.current = null;
    if (!work()) return;
    void send(true).then(redraw, () => !gone.current && flush());
  };

  const latest = useRef({ save, leave });
  latest.current = { save, leave };
  useEffect(() => {
    gone.current = false;
    const onHide = () => latest.current.leave();
    const onVisible = () => document.visibilityState === 'hidden' && latest.current.leave();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisible);
    // Kept edits that no longer apply (changed elsewhere since) are forgotten, so a later reload cannot bring them back.
    if (made.current && base.current) keepNow();
    // Kept words that can be saved (the page went mid-pause or mid-create) are saved now; an on one's wait for leaving.
    if (work(true)) latest.current.save(true);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisible);
      if (retry.current) clearTimeout(retry.current);
      if (pause.current) clearTimeout(pause.current);
      pause.current = retry.current = null;
      // Closed or another routine opened: what waits is saved; a new one made now does not open again.
      gone.current = true;
      if (work()) void send(false).catch(() => {});
    };
  }, []);

  // A change made elsewhere (another window, an agent, this window's own save) comes in, but never over a field being
  // typed in: a field takes theirs only while it still shows what the server had before.
  const seen = useRef(opts.record);
  useEffect(() => {
    const record = opts.record;
    const before = seen.current;
    seen.current = record;
    if (!record || before === record) return;
    if (record.updated_at >= lastAt.current) {
      lastAt.current = record.updated_at;
      rowOn.current = routineOn(record);
    }
    if (!before) {
      base.current = fieldsOf(record);
      // Opened by its link before the list was read: the record fills the fields. One made here keeps its words.
      if (!createdHere.current) setDraft(withKept(made.current, fieldsOf(record)));
      return;
    }
    const theirs = fieldsOf(record);
    const was = fieldsOf(before);
    const next = { ...typed.current };
    let taken = false;
    for (const k of keysOf(theirs, was)) {
      if (json(theirs[k]) === json(was[k])) continue;
      base.current = { ...(base.current ?? theirs), [k]: theirs[k] };
      if (json(typed.current[k]) === json(was[k])) {
        Object.assign(next, { [k]: theirs[k] });
        taken = true;
      }
    }
    if (taken) setDraft(next);
    else redraw();
  }, [opts.record]);

  const status = (): SaveStatus => {
    const d = typed.current;
    if (failed.current?.retrying) return { kind: 'failed' };
    if (failed.current) return { kind: 'refused', message: failed.current.message };
    if (!made.current) return missing(d) || heldAny(d) ? { kind: 'new' } : { kind: 'saving' };
    if (!d.name.trim()) return { kind: 'needs', field: 'name' };
    if (!d.prompt.trim()) return { kind: 'needs', field: 'prompt' };
    if (busy.current || pause.current) return { kind: 'saving' };
    if (work(true)) return { kind: 'saving' };
    return work() ? { kind: 'held' } : { kind: 'saved' };
  };

  return {
    draft,
    status: status(),
    /** Typed into a field: saved after the typing pause (an on routine's name and prompt: when the field is left). */
    type: (change: Partial<ScheduledFields>) => {
      setDraft({ ...typed.current, ...change });
      if (holding() && (Object.keys(change) as Key[]).every((k) => TYPED.includes(k))) return;
      if (pause.current) clearTimeout(pause.current);
      pause.current = setTimeout(() => latest.current.save(true), TYPING_PAUSE_MS);
    },
    /** A pick, or a change shown without a pause (a schedule step): saved at once. */
    pick: (change: Partial<ScheduledFields>) => {
      setDraft({ ...typed.current, ...change });
      save(true);
    },
    /** A field left: what waits is saved now, an on one's typing too. */
    flush,
    /** A held field let go (the schedule preview answered): saved now, an on one's typing still waits. */
    release: () => save(true),
    /** Before an action that reads the saved routine (Run once now, a turn): what waits is saved. False when it is not. */
    settle: async (): Promise<boolean> => {
      flush();
      for (let i = 0; i < 6 && busy.current; i++) await busy.current;
      const d = typed.current;
      return !failed.current && !work() && !missing(d);
    },
    /** A new one's Turn on: made on, or turned on once made. */
    turnOn: () => {
      wantOn.current = true;
      flush();
    },
    /** A new one's Delete: forgotten, never made (one being made now is deleted when it answers). */
    drop: () => {
      dropped.current = true;
      forgetKeptRoutine();
    },
  };
}
