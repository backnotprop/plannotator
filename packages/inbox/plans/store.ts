/**
 * The window's Plans data: the list, read once and shared (the sidebar's count and the home page), one plan with its
 * versions, a version's text and the two texts of a diff. Read only while Plans is on and something shows it. There
 * is no Plans event on the stream yet, so the list is read when the page opens, when the window comes back into
 * view, and every 2 s while the Inbox is still bringing in plan history (`importing`); each read also has the Inbox
 * pick up what plan review wrote since (packages/server/plans-capability.ts).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PlanSummary, PlanVersion } from '@plannotator/core/plans';
import type { SettingsModel } from '../api';
import { InboxApiError } from '../apiError';
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
}

const EMPTY: PlansSnapshot = { plans: null, importing: false, error: null, off: false, importError: null };
let on = false;
let snap = EMPTY;
let reading: Promise<void> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(next: Partial<PlansSnapshot>) {
  snap = { ...snap, ...next };
  for (const listener of listeners) listener();
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isOff = (error: unknown) => error instanceof InboxApiError && error.status === 404;

/** `retry`: the list's Try again after the Inbox could not read the plan history. */
export function readPlans(retry = false): Promise<void> {
  if (!on) return Promise.resolve();
  if (reading) return reading;
  reading = plansApi.list(retry).then(
    (answer) => emit({ plans: answer.plans, importing: answer.importing, error: null, off: false, importError: answer.import_error ?? null }),
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

/** The home page: reads again when it opens and when the window comes back into view. */
export function usePlansPage(): PlansSnapshot {
  useEffect(() => {
    void readPlans();
    const back = () => {
      if (document.visibilityState === 'visible') void readPlans();
    };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);
  return usePlans();
}

/** The window's switch, from its settings (`plans` is present only while on). */
export function usePlansOn(settings: Pick<SettingsModel, 'plans'> | null): boolean {
  const value = settings?.plans?.on === true;
  useEffect(() => setPlansOn(value), [value]);
  return value;
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

/** One plan and its primary document's versions, read when it opens (and on `retry`). */
export function usePlan(id: string, retry: number): PlanState {
  const [state, setState] = useState<PlanState>({ read: null, versions: null, error: null, missing: false });
  useEffect(() => {
    let live = true;
    setState({ read: null, versions: null, error: null, missing: false });
    Promise.all([plansApi.read(id), plansApi.versions(id)]).then(
      ([read, list]) => live && setState({ read, versions: list.versions, error: null, missing: false }),
      (error: unknown) => live && setState({ read: null, versions: null, error: messageOf(error), missing: isOff(error) }),
    );
    return () => {
      live = false;
    };
  }, [id, retry]);
  return state;
}

/** Another document's versions (`doc` null: none read, the plan's own come with `usePlan`). */
export function useDocVersions(id: string, doc: string | null, retry: number): { versions: readonly PlanVersion[] | null; error: string | null } {
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
  }, [id, doc, key, retry]);
  return state.key === key ? { versions: state.versions, error: state.error } : { versions: null, error: null };
}

/** A version's bytes never change, nor an artifact's (a new one is a new record): each is read once per window. */
const texts = new Map<string, Promise<string>>();

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
  snap = { ...EMPTY, plans };
}
