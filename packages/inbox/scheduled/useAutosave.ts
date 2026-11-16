/**
 * The routine editor's saving (approval "inbox-routine-editor-autosave"). A field saves after a typing pause, when it
 * is left, at once for a pick, and with `keepalive` as the page hides or goes (pagehide, visibilitychange). Only what
 * differs from the last save is sent. A write that gets no answer, or a 5xx, is tried again with a growing pause and
 * the words stay in the field; a refusal (4xx) is said and waits for the next edit. An emptied name or prompt is not
 * sent (a routine needs both): the status says which is missing, and the field is never put back while typed in.
 *
 * A new routine is made once it has a name and a prompt, with one key for every try (the server answers a key's
 * routine again), and until then it is kept in the tab's sessionStorage (routineDraft.ts). The editor stays mounted
 * when the new one takes its id (ScheduledPage), so words typed while it is being made, and the cursor, stay.
 */
import { useEffect, useRef, useState } from 'react';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { InboxApiError } from '../apiError';
import { newUuid } from '../uuid';
import { scheduledApi, type ScheduledFields } from './client';
import { forgetKeptRoutine, keepRoutine, readKeptRoutine } from './routineDraft';
import { putScheduled } from './store';

export const TYPING_PAUSE_MS = 600;
export const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export type SaveStatus =
  | { kind: 'new' | 'saving' | 'saved' | 'failed' }
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
const keysOf = (...all: ScheduledFields[]) => [...new Set(all.flatMap((f) => Object.keys(f)))] as Key[];
/** No answer at all (the fetch threw), or the Inbox failing or busy: worth another try. */
const retryable = (cause: unknown) => !(cause instanceof InboxApiError) || cause.status >= 500 || cause.status === 408 || cause.status === 429;

export function useAutosave(opts: {
  id: string;
  record: InboxScheduledRow | null;
  /** A new one's fields before anything is typed. */
  fresh: () => ScheduledFields;
  /** A field not to send yet: a schedule the preview refused or has not answered. */
  held: (key: Key, fields: ScheduledFields) => boolean;
  onCreated: (id: string) => void;
}) {
  const live = useRef(opts);
  live.current = opts;
  const kept = useRef(opts.id === 'new' ? readKeptRoutine() : null);
  const [draft, setDraftState] = useState<ScheduledFields>(() => (opts.record ? fieldsOf(opts.record) : (kept.current?.fields ?? opts.fresh())));
  const typed = useRef(draft);
  /** What the server has, as far as this window knows; null before a new one is made or a linked one is read. */
  const base = useRef<ScheduledFields | null>(opts.record ? fieldsOf(opts.record) : null);
  const made = useRef<string | null>(opts.id === 'new' ? null : opts.id);
  const createdHere = useRef(false);
  const key = useRef(kept.current?.key ?? newUuid());
  const wantOn = useRef(false);
  const busy = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tries = useRef(0);
  const gone = useRef(false);
  const dropped = useRef(false);
  const [failure, setFailure] = useState<{ retrying: boolean; message: string } | null>(null);
  const [, rerender] = useState(0);
  const redraw = () => !gone.current && rerender((n) => n + 1);

  const setDraft = (next: ScheduledFields) => {
    typed.current = next;
    setDraftState(next);
    if (!made.current && !dropped.current) keepRoutine(next, key.current);
  };
  const missing = (fields: ScheduledFields) => !fields.name.trim() || !fields.prompt.trim();
  const heldAny = (fields: ScheduledFields) => keysOf(fields).some((k) => live.current.held(k, fields));
  /** What differs from the server's, less an emptied name or prompt and anything held. */
  const changes = (): Partial<ScheduledFields> => {
    const d = typed.current;
    const b = base.current;
    const out: Partial<ScheduledFields> = {};
    if (!b) return out;
    for (const k of keysOf(d, b)) {
      if (norm(k, d[k]) === norm(k, b[k])) continue;
      if ((k === 'name' || k === 'prompt') && !d[k].trim()) continue;
      if (live.current.held(k, d)) continue;
      Object.assign(out, { [k]: d[k] });
    }
    return out;
  };
  const work = () => {
    if (dropped.current) return false;
    if (!made.current) return !missing(typed.current) && !heldAny(typed.current);
    return Object.keys(changes()).length > 0 || wantOn.current;
  };

  const send = async (keepalive: boolean): Promise<void> => {
    if (dropped.current) return;
    const d = typed.current;
    if (!made.current) {
      if (missing(d) || heldAny(d)) return;
      const answer = await scheduledApi.create({ ...d, ...(wantOn.current ? { enabled: true } : {}) }, key.current, keepalive);
      // A keepalive and an ordinary create raced: one key, one routine.
      if (made.current) return;
      made.current = answer.scheduled.id;
      createdHere.current = true;
      base.current = fieldsOf(answer.scheduled);
      if (answer.scheduled.state !== 'off') wantOn.current = false;
      forgetKeptRoutine();
      putScheduled(answer.scheduled);
      if (!gone.current) live.current.onCreated(answer.scheduled.id);
      return;
    }
    const change = changes();
    if (Object.keys(change).length > 0) {
      const answer = await scheduledApi.update(made.current, change, keepalive);
      base.current = { ...(base.current ?? d), ...change };
      putScheduled(answer.scheduled);
    }
    if (wantOn.current) {
      wantOn.current = false;
      putScheduled((await scheduledApi.turn(made.current, true)).scheduled);
    }
  };

  const flush = () => {
    if (pause.current) clearTimeout(pause.current);
    pause.current = null;
    if (busy.current) {
      again.current = true;
      return;
    }
    if (!work()) return void redraw();
    if (retry.current) clearTimeout(retry.current);
    retry.current = null;
    let failed = false;
    const run = send(false).then(
      () => {
        tries.current = 0;
        if (!gone.current) setFailure(null);
      },
      (cause: unknown) => {
        failed = true;
        if (gone.current) return;
        if (retryable(cause)) {
          retry.current = setTimeout(flush, RETRY_MS[Math.min(tries.current++, RETRY_MS.length - 1)]);
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
      if (!gone.current && !failed && (more || work())) flush();
      else redraw();
    });
  };
  /** The page hides or goes: what waits is sent now and outlives the page. */
  const leave = () => {
    if (pause.current) clearTimeout(pause.current);
    pause.current = null;
    if (!work()) return;
    void send(true).then(redraw, () => !gone.current && flush());
  };

  const latest = useRef({ flush, leave });
  latest.current = { flush, leave };
  useEffect(() => {
    gone.current = false;
    const onHide = () => latest.current.leave();
    const onVisible = () => document.visibilityState === 'hidden' && latest.current.leave();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisible);
    // A kept new one that already has a name and a prompt (the page went mid-pause or mid-create) is made now.
    if (!made.current && work()) latest.current.flush();
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisible);
      if (retry.current) clearTimeout(retry.current);
      // Closed or another routine opened: what waits is saved; a new one made now does not open again.
      gone.current = true;
      if (pause.current || retry.current || work()) void send(false).catch(() => {});
      if (pause.current) clearTimeout(pause.current);
      pause.current = retry.current = null;
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
    if (!before) {
      base.current = fieldsOf(record);
      // Opened by its link before the list was read: the record fills the fields. One made here keeps its words.
      if (!createdHere.current) setDraft(fieldsOf(record));
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
    if (failure?.retrying) return { kind: 'failed' };
    if (failure) return { kind: 'refused', message: failure.message };
    if (!made.current) return missing(d) || heldAny(d) ? { kind: 'new' } : { kind: 'saving' };
    if (!d.name.trim()) return { kind: 'needs', field: 'name' };
    if (!d.prompt.trim()) return { kind: 'needs', field: 'prompt' };
    return busy.current || pause.current || work() ? { kind: 'saving' } : { kind: 'saved' };
  };

  return {
    draft,
    status: status(),
    /** Typed into a field: saved after the typing pause. */
    type: (change: Partial<ScheduledFields>) => {
      setDraft({ ...typed.current, ...change });
      if (pause.current) clearTimeout(pause.current);
      pause.current = setTimeout(() => latest.current.flush(), TYPING_PAUSE_MS);
    },
    /** A pick, or a change shown without a pause (a schedule step): saved at once. */
    pick: (change: Partial<ScheduledFields>) => {
      setDraft({ ...typed.current, ...change });
      flush();
    },
    /** A field left, or a held field let go: what waits is saved now. */
    flush,
    /** What waits, saved before an action that reads the record (Run once now). */
    settle: async () => {
      flush();
      for (let i = 0; i < 4 && busy.current; i++) await busy.current;
    },
    /** A new one's Turn on: made on, or turned on once made. */
    turnOn: () => {
      wantOn.current = true;
      flush();
    },
    /** A new one's Delete: forgotten, never made. */
    drop: () => {
      dropped.current = true;
      forgetKeptRoutine();
    },
  };
}
