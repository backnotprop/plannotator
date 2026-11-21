/**
 * The window's Plans data: the list, read once and shared (the sidebar's count and the home page), one plan with its
 * versions, a version's text and the two texts of a diff. Read only while Plans is on and something shows it. There
 * is no Plans event on the stream yet, so the list is read when the page opens, when the window comes back into
 * view, every 5 s while the Spaces home is shown, and every 2 s while the Inbox is still bringing in plan history
 * (`importing`); each read also has the Inbox pick up what plan review wrote since (packages/server/plans-capability.ts).
 * A read that brings nothing new changes nothing: the Inbox answers 304 to the last `ETag`, and an answer equal to
 * what is shown is not passed on, so nothing draws again.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { planPinsWith, type PlanFaceText, type PlanSummary, type PlanVersion, type SpacesView } from '@plannotator/core/plans';
import type { SettingsModel } from '../api';
import type { InboxToastModel } from '../components/Toast';
import { InboxApiError } from '../apiError';
import { errorToast } from '../toastError';
import { plansApi, type PlanDiffTexts, type PlanRead } from './client';
import { setSidebarUnsaved } from '../sidebarLayout';

export const PLANS_IMPORT_POLL_MS = 2000;

export interface PlansSnapshot {
  plans: readonly PlanSummary[] | null;
  importing: boolean;
  error: string | null;
  /** The Inbox answered 404: Plans was turned off since this window read its settings. */
  off: boolean;
  /** The Inbox could not read the plan history (its message): the list holds what it read before. */
  importError: string | null;
  /** The person's pinned plans, in their order. */
  pins: readonly string[];
  /** The Spaces home's view, the person's; null until the first read (an Inbox before Spaces: cards). */
  view: SpacesView | null;
}

const EMPTY: PlansSnapshot = { plans: null, importing: false, error: null, off: false, importError: null, pins: [], view: null };
let on = false;
let snap = EMPTY;
let reading: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
// The last list answer's tag (the Inbox answers 304 while it holds), and what the shown plans were read as.
let listTag: string | null = null;
let plansRead = '';
// Each pin or view written here counts one: a read that began before a write does not put back what it held.
let writeGen = 0;

function emit(next: Partial<PlansSnapshot>) {
  snap = { ...snap, ...next };
  for (const listener of listeners) listener();
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isOff = (error: unknown) => error instanceof InboxApiError && error.status === 404;
const samePins = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** The old home's "compact" choice (this browser's), carried to the Spaces list once, then forgotten. */
export const OLD_PLANS_VIEW_KEY = 'plannotator-inbox-plans-view';
function carryOldView(view: SpacesView): void {
  try {
    const old = localStorage.getItem(OLD_PLANS_VIEW_KEY);
    if (old === null) return;
    localStorage.removeItem(OLD_PLANS_VIEW_KEY);
    if (old === 'compact' && view !== 'list') void setSpacesView('list');
  } catch {
    // No storage here: nothing to carry.
  }
}

/** `retry`: the list's Try again after the Inbox could not read the plan history. `poll`: the home's timed read. */
export function readPlans(retry = false, poll = false): Promise<void> {
  if (!on) return Promise.resolve();
  if (reading) return reading;
  const gen = writeGen;
  reading = plansApi.list(retry, { poll, etag: snap.plans && !snap.error && !snap.off ? listTag : null }).then(
    (got) => {
      // 304: the list is what it was.
      if (!got) return;
      const answer = got.list;
      const next: Partial<PlansSnapshot> = {};
      const read = JSON.stringify(answer.plans);
      if (snap.plans === null || read !== plansRead) {
        next.plans = answer.plans;
        plansRead = read;
      }
      if (snap.importing !== answer.importing) next.importing = answer.importing;
      if (snap.error !== null) next.error = null;
      if (snap.off) next.off = false;
      if (snap.importError !== (answer.import_error ?? null)) next.importError = answer.import_error ?? null;
      // A pin or view written since this read began (or still on its way) wins: the read does not put back what it
      // held before, and the next read is a whole one.
      const stale = gen !== writeGen || pinWrites > 0 || viewWrites > 0;
      listTag = stale ? null : got.etag;
      if (!stale && !samePins(snap.pins, answer.pins ?? [])) next.pins = answer.pins ?? [];
      if (!stale && snap.view !== (answer.view ?? 'cards')) next.view = answer.view ?? 'cards';
      const first = snap.view === null && next.view;
      if (Object.keys(next).length) emit(next);
      if (first) carryOldView(next.view!);
    },
    (error: unknown) => emit(isOff(error) ? { off: true, error: null } : { error: messageOf(error) }),
  );
  return reading.finally(() => {
    reading = null;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (on && snap.importing && listeners.size > 0) pollTimer = setTimeout(() => void readPlans(), PLANS_IMPORT_POLL_MS);
  });
}

export function setPlansOn(next: boolean): void {
  // Off, its sidebar row is never saved in the layout (sidebarLayout.ts): nothing of an off Plans is written.
  setSidebarUnsaved(next ? [] : ['plans']);
  if (on === next) return;
  on = next;
  if (!on) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    emit(EMPTY);
  } else if (listeners.size > 0) void readPlans();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (on && snap.plans === null && !reading) void readPlans();
  return () => listeners.delete(listener);
}
const current = () => snap;

export function usePlans(): PlansSnapshot {
  return useSyncExternalStore(subscribe, current, current);
}

/**
 * How often the home reads the list again while it is shown and in view, so what an agent sends (plan review's next
 * version, which a read also picks up) arrives on the open home (approval "plans-home": in place, its place held).
 */
export const PLANS_HOME_POLL_MS = 5000;

/** The home page: reads again when it opens, every few seconds while in view, and when the window comes back into view. */
export function usePlansPage(): PlansSnapshot {
  useEffect(() => {
    void readPlans();
    const back = () => {
      if (document.visibilityState === 'visible') void readPlans();
    };
    document.addEventListener('visibilitychange', back);
    const timer = setInterval(() => document.visibilityState === 'visible' && void readPlans(false, true), PLANS_HOME_POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', back);
      clearInterval(timer);
    };
  }, []);
  return usePlans();
}

// Share this space's own switch (the settings answer's `plans.share`, config.json `inboxSpaceShare`): off, the plan
// page draws no Share button and reads nothing of a share.
let shareOn = false;
const shareListeners = new Set<() => void>();
export function setPlanShareOn(next: boolean): void {
  if (shareOn === next) return;
  shareOn = next;
  for (const listener of shareListeners) listener();
}
const subscribeShare = (listener: () => void) => {
  shareListeners.add(listener);
  return () => shareListeners.delete(listener);
};
const shareNow = () => shareOn;
export function usePlanShareOn(): boolean {
  return useSyncExternalStore(subscribeShare, shareNow, shareNow);
}

type PlansToast = (toast: Omit<InboxToastModel, 'id'>) => void;
let toastTo: PlansToast | null = null;

/** The window's switch, from its settings (`plans` is present only while on); `toast`: the window's, for Plans' errors. */
export function usePlansOn(settings: Pick<SettingsModel, 'plans'> | null, toast?: PlansToast): boolean {
  const value = settings?.plans?.on === true;
  useEffect(() => setPlansOn(value), [value]);
  const share = value && settings?.plans?.share === true;
  useEffect(() => setPlanShareOn(share), [share]);
  useEffect(() => {
    toastTo = toast ?? null;
  }, [toast]);
  return value;
}

/** A Plans write failed: the window's toast says so (as every Inbox write does), where there is a window. */
export function plansWriteFailed(cause: unknown, fallback: string): void {
  toastTo?.(errorToast(cause, fallback));
}

let pinWrites = 0;
let viewWrites = 0;

/**
 * Pin a plan (at `index`, else last), move it, or unpin it: shown at once, then the Inbox's order. A failed write puts
 * the order back and the window's toast says so ("The space was not pinned.").
 */
export async function setPlanPin(id: string, pinned: boolean, index: number | null = null): Promise<void> {
  const before = snap.pins;
  writeGen++;
  emit({ pins: planPinsWith(before, id, pinned, index) });
  pinWrites++;
  try {
    const answer = await plansApi.pin(id, pinned, index);
    emit({ pins: answer.pins });
  } catch (error) {
    emit({ pins: before });
    plansWriteFailed(error, !pinned ? 'The space was not unpinned.' : before.includes(id) ? 'The space was not moved.' : 'The space was not pinned.');
  } finally {
    pinWrites--;
  }
}

/** The Spaces home's view: shown at once, kept for the person; a failed save keeps it for this window. */
export async function setSpacesView(view: SpacesView): Promise<void> {
  writeGen++;
  emit({ view });
  viewWrites++;
  try {
    await plansApi.saveView(view);
  } catch {
    // config.json could not be written: the view holds for this window.
  } finally {
    viewWrites--;
  }
}

/** A look was recorded: the plan is no longer "changed" in the list, before the next read says so. */
function putLooked(id: string, seen: number): void {
  if (!snap.plans) return;
  emit({
    plans: snap.plans.map((p) => (p.id === id ? { ...p, changed: false, looked_at: new Date().toISOString(), seen_version_number: Math.max(p.seen_version_number ?? 0, seen) } : p)),
  });
}

/** The person read version `seen` (of document `doc`; null: the plan's own). A failure only means the mark stays until the next look. */
export function recordPlanLook(id: string, seen: number, doc: string | null = null): void {
  if (!doc) putLooked(id, seen);
  plansApi.look(id, seen, doc).catch(() => {});
}

export interface PlanState {
  read: PlanRead | null;
  versions: readonly PlanVersion[] | null;
  error: string | null;
  missing: boolean;
}

/**
 * One plan and its primary document's versions, read when it opens (and on `retry`). `fresh`: read again after a
 * write of the page's own (a version, an approval, a Send), keeping what is on screen until the answer comes.
 */
export function usePlan(id: string, retry: number, fresh = 0): PlanState {
  const [state, setState] = useState<PlanState>({ read: null, versions: null, error: null, missing: false });
  const readFor = useRef('');
  useEffect(() => {
    let live = true;
    if (readFor.current !== `${id}:${retry}`) setState({ read: null, versions: null, error: null, missing: false });
    readFor.current = `${id}:${retry}`;
    Promise.all([plansApi.read(id), plansApi.versions(id)]).then(
      ([read, list]) => live && setState({ read, versions: list.versions, error: null, missing: false }),
      (error: unknown) => live && setState({ read: null, versions: null, error: messageOf(error), missing: isOff(error) }),
    );
    return () => {
      live = false;
    };
  }, [id, retry, fresh]);
  return state;
}

/** Another document's versions (`doc` null: none read, the plan's own come with `usePlan`). */
export function useDocVersions(id: string, doc: string | null, retry: number, fresh = 0): { versions: readonly PlanVersion[] | null; error: string | null } {
  const [state, setState] = useState<{ key: string; versions: readonly PlanVersion[] | null; error: string | null }>({ key: '', versions: null, error: null });
  const key = doc ? `${id}:${doc}` : '';
  useEffect(() => {
    if (!doc) return;
    let live = true;
    plansApi.versions(id, doc).then(
      (list) => live && setState({ key, versions: list.versions, error: null }),
      (error: unknown) => live && setState({ key, versions: null, error: messageOf(error) }),
    );
    return () => {
      live = false;
    };
  }, [id, doc, key, retry, fresh]);
  return state.key === key ? { versions: state.versions, error: state.error } : { versions: null, error: null };
}

/**
 * A version's bytes never change, nor an artifact's (a new one is a new record): each is read once per window. Reading
 * a plan document's version drops that document's older versions read before (`forgetOlder`), so a plan that keeps
 * getting versions does not keep every one.
 */
const texts = new Map<string, Promise<string>>();

/** Keys are `<prefix><n>`: drop those of the same prefix below `n`. */
function forgetOlder<T>(cache: Map<string, T>, prefix: string, n: number): void {
  for (const key of cache.keys()) {
    if (!key.startsWith(prefix)) continue;
    const m = Number(key.slice(prefix.length));
    if (Number.isInteger(m) && m < n) cache.delete(key);
  }
}

/** The faces' tops of versions (`GET …/versions/:n?face=1`), one per plan: a newer one drops the one before. */
const faces = new Map<string, Promise<PlanFaceText>>();

/**
 * The top of a plan's main page version `n`, for its face. While a newer version is read, the one before stays (the
 * face never goes blank); null until the first comes, and when it could not be read.
 */
export function useFaceText(id: string, n: number | null): PlanFaceText | null {
  const [state, setState] = useState<{ id: string; face: PlanFaceText | null }>({ id, face: null });
  useEffect(() => {
    if (n === null) return;
    let live = true;
    const key = `${id}:${n}`;
    let read = faces.get(key);
    if (!read) {
      read = plansApi.face(id, n);
      faces.set(key, read);
      forgetOlder(faces, `${id}:`, n);
      read.catch(() => faces.delete(key));
    }
    read.then(
      (face) => live && setState({ id, face }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [id, n]);
  return state.id === id ? state.face : null;
}

/** An artifact's bytes as text (an HTML page, an SVG); `hash` tells a changed file from the one read before. */
export function useArtifactText(id: string, assetPath: string | null, hash: string, retry: number): { text: string | null; error: string | null } {
  const [state, setState] = useState<{ key: string; text: string | null; error: string | null }>({ key: '', text: null, error: null });
  const key = assetPath ? `file:${id}:${assetPath}:${hash}` : '';
  useEffect(() => {
    if (!assetPath) return;
    let live = true;
    let read = texts.get(key);
    if (!read) {
      read = plansApi.fileText(id, assetPath);
      texts.set(key, read);
      read.catch(() => texts.delete(key));
    }
    read.then(
      (text) => live && setState({ key, text, error: null }),
      (error: unknown) => live && setState({ key, text: null, error: messageOf(error) }),
    );
    return () => {
      live = false;
    };
  }, [id, assetPath, key, retry]);
  return state.key === key ? { text: state.text, error: state.error } : { text: null, error: null };
}

export function useVersionText(id: string, n: number | null, retry: number, doc: string | null = null): { text: string | null; error: string | null } {
  const [state, setState] = useState<{ key: string; text: string | null; error: string | null }>({ key: '', text: null, error: null });
  const key = n === null ? '' : `${id}:${doc ?? ''}:${n}`;
  useEffect(() => {
    if (n === null) return;
    let live = true;
    let read = texts.get(key);
    if (!read) {
      read = plansApi.version(id, n, doc);
      texts.set(key, read);
      forgetOlder(texts, `${id}:${doc ?? ''}:`, n);
      read.catch(() => texts.delete(key));
    }
    read.then(
      (text) => live && setState({ key, text, error: null }),
      (error: unknown) => live && setState({ key, text: null, error: messageOf(error) }),
    );
    return () => {
      live = false;
    };
  }, [id, n, doc, key, retry]);
  return state.key === key ? { text: state.text, error: state.error } : { text: null, error: null };
}

export function usePlanDiff(id: string, from: number, to: number, retry: number, doc: string | null = null): { diff: PlanDiffTexts | null; error: string | null } {
  const [state, setState] = useState<{ key: string; diff: PlanDiffTexts | null; error: string | null }>({ key: '', diff: null, error: null });
  const key = `${id}:${doc ?? ''}:${from}:${to}`;
  useEffect(() => {
    let live = true;
    plansApi.diff(id, from, to, doc).then(
      (diff) => live && setState({ key, diff, error: null }),
      (error: unknown) => live && setState({ key, diff: null, error: messageOf(error) }),
    );
    return () => {
      live = false;
    };
  }, [id, from, to, doc, key, retry]);
  return state.key === key ? { diff: state.diff, error: state.error } : { diff: null, error: null };
}

/** Tests: a fresh store. */
export function resetPlansForTests(plans: readonly PlanSummary[] | null = null, isOn = plans !== null): void {
  on = isOn;
  reading = null;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  texts.clear();
  faces.clear();
  pinWrites = 0;
  viewWrites = 0;
  writeGen = 0;
  listTag = null;
  plansRead = '';
  snap = { ...EMPTY, plans };
}
