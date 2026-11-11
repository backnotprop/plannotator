import { useCallback, useSyncExternalStore } from 'react';
import { readInboxAgentFaces, type InboxAgentFaceEntry } from '@plannotator/core/inbox-types';
import type { InboxAgent } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { inboxAgentsFlat, inboxAgentsNow, onInboxAgentsSet } from '../agentsList';
import { AGENT_FACES, type AgentFace, type OurFace } from './faceChoices';
import { loadAgentFaceArt } from './faceArtLoad';
import { hearOwnIcons, ownFaceShows, ownIconsNow } from './ownIcons';
import { pictureFromFile } from '../projectPictures';
import { errorText } from '../toastError';

export const AGENT_FACES_KEY = 'plannotator-inbox-agent-faces';
export const AGENT_FACES_PAINT_KEY = 'plannotator-inbox-agent-faces-v2';

export type AgentFaceRef = string | Pick<InboxAgent, 'id' | 'session' | 'continues'>;

type Entries = Record<string, InboxAgentFaceEntry>;
type Shown = Exclude<AgentFace, 'agent'>;

let server: { faces: Entries; rev: number } | null = null;
let legacy: Record<string, OurFace> | null = null;
const pending = new Map<string, { face: AgentFace; sessions: string[] }>();
let resolved = new Map<string, Shown>();
let ready = false;
let watching = false;
const listeners = new Map<string, Set<() => void>>();

function storageGet(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readLegacy(): Record<string, OurFace> | null {
  const raw = storageGet(AGENT_FACES_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, OurFace> = {};
  for (const [id, face] of Object.entries(raw as Record<string, unknown>)) if (face !== 'agent' && (AGENT_FACES as readonly unknown[]).includes(face)) out[id] = face as OurFace;
  return Object.keys(out).length > 0 ? out : null;
}

function boot(): void {
  if (ready) return;
  ready = true;
  const paint = storageGet(AGENT_FACES_PAINT_KEY) as { faces?: unknown; rev?: unknown } | null;
  if (paint && typeof paint === 'object') {
    server = { faces: readInboxAgentFaces(paint.faces), rev: typeof paint.rev === 'number' ? paint.rev : 0 };
    hearOwnIcons((paint as { icons?: unknown }).icons);
  }
  legacy = readLegacy();
  if (!watching) {
    watching = true;
    onInboxAgentsSet(() => queueMicrotask(rebuild));
  }
  rebuild();
}

function entries(withLegacy = true): Entries {
  const out = Object.assign(Object.create(null), server?.faces ?? {}) as Entries;
  if (withLegacy) for (const [key, face] of Object.entries(legacy ?? {})) if (!out[key]) out[key] = { face, sessions: [] };
  for (const [key, change] of pending) {
    const before = out[key];
    delete out[key];
    for (const session of change.sessions) delete out[session];
    if (change.face !== 'agent') out[key] = { face: change.face, sessions: [...new Set([...(before?.sessions ?? []), ...change.sessions])] };
  }
  return out;
}

const chainOf = (agent: Pick<InboxAgent, 'id' | 'session' | 'continues'>) => [agent.id, agent.session, ...(agent.continues ?? [])];

function rebuild(): void {
  const next = new Map<string, Shown>();
  for (const [key, entry] of Object.entries(entries())) {
    if (entry.face.startsWith('own:') && !ownFaceShows(entry.face)) continue;
    next.set(key, entry.face);
    for (const session of entry.sessions) next.set(session, entry.face);
  }
  const direct = new Map(next);
  for (const agent of inboxAgentsFlat(inboxAgentsNow())) {
    const chain = chainOf(agent);
    const face = chain.map((id) => direct.get(id)).find((found) => found !== undefined);
    if (face) for (const id of chain) if (!direct.has(id)) next.set(id, face);
  }
  const was = resolved;
  resolved = next;
  if ([...next.values()].some((face) => !face.startsWith('own:') && !face.startsWith('set:'))) void loadAgentFaceArt().catch(() => {});
  const changed = new Set<string>();
  for (const [id, face] of next) if (was.get(id) !== face) changed.add(id);
  for (const id of was.keys()) if (!next.has(id)) changed.add(id);
  for (const id of changed) for (const listener of [...(listeners.get(id) ?? [])]) listener();
}

function keepPaint(): void {
  try {
    if (server || pending.size > 0) window.localStorage.setItem(AGENT_FACES_PAINT_KEY, JSON.stringify({ faces: entries(false), rev: server?.rev ?? 0, ...(ownIconsNow() ? { icons: ownIconsNow() } : {}) }));
  } catch {
  }
}

function hear(wire: unknown, force: boolean): boolean {
  const data = wire as { faces?: unknown; rev?: unknown; icons?: unknown } | null;
  if (!data || typeof data !== 'object' || typeof data.rev !== 'number') return false;
  if (!force && server && data.rev <= server.rev) return false;
  server = { faces: readInboxAgentFaces(data.faces), rev: data.rev };
  hearOwnIcons(data.icons);
  keepPaint();
  rebuild();
  return true;
}

export function agentFaceOf(id: string | null | undefined): AgentFace {
  boot();
  return (id && resolved.get(id)) || 'agent';
}

let sending: Promise<void> | null = null;
async function send(): Promise<void> {
  while (true) {
    const next = [...pending].find(([, change]) => !sentNow.has(change));
    if (!next) return;
    const [agent, change] = next;
    sentNow.add(change);
    try {
      const answer = await inboxApi.saveAgentFace({ agent, sessions: change.sessions, face: change.face });
      if (pending.get(agent) === change) pending.delete(agent);
      if (!hear(answer, false)) rebuild();
    } catch {
    }
  }
}
const sentNow = new WeakSet<object>();

export function keepAgentFace(agent: AgentFaceRef, face: AgentFace): void {
  boot();
  const ref = typeof agent === 'string' ? { id: agent, session: agent } : agent;
  const sessions = [...new Set(chainOf(ref).filter((id) => id !== ref.id))];
  pending.delete(ref.id);
  pending.set(ref.id, { face, sessions });
  keepPaint();
  rebuild();
  sending ??= send().finally(() => {
    sending = null;
  });
}

export async function keepOwnPicture(agent: AgentFaceRef, file: Blob): Promise<string | null> {
  boot();
  try {
    const read = await pictureFromFile(file);
    if ('refused' in read) return read.refused;
    const answer = await inboxApi.uploadAgentIcon(read.picture);
    const id = (answer.icon as { id?: unknown } | undefined)?.id;
    hear(answer, false);
    if (typeof id !== 'string') return 'The picture did not change.';
    keepAgentFace(agent, `own:${id}`);
    return null;
  } catch (cause) {
    return errorText(cause, 'The picture did not change.');
  }
}

export async function removeOwnPicture(id: string): Promise<string | null> {
  boot();
  try {
    hear(await inboxApi.removeAgentIcon(id), false);
    return null;
  } catch (cause) {
    return errorText(cause, 'The picture did not change.');
  }
}

export async function readAgentFaces(): Promise<void> {
  boot();
  let answer: unknown;
  try {
    answer = await inboxApi.agentFaces();
  } catch {
    return;
  }
  for (const [agent, change] of pending) if (sentNow.has(change) && !sending) pending.delete(agent);
  hear(answer, true);
  const old = legacy;
  if (!old) return;
  try {
    const adopted = await inboxApi.saveAgentFace({ adopt: old });
    legacy = null;
    try {
      window.localStorage.removeItem(AGENT_FACES_KEY);
    } catch {
    }
    if (!hear(adopted, true)) rebuild();
  } catch {
  }
}

export function hearAgentFacesEvent(data: unknown): void {
  boot();
  hear(data, false);
}

function subscribeTo(id: string, listener: () => void): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(id);
  };
}
const nothing = () => () => {};
const plain = (): AgentFace => 'agent';

export function useAgentFace(id: string | null | undefined): AgentFace {
  const subscribe = useCallback((listener: () => void) => (id ? subscribeTo(id, listener) : nothing()), [id]);
  return useSyncExternalStore(subscribe, () => agentFaceOf(id), plain);
}

export function resetAgentFaces(): void {
  server = null;
  legacy = null;
  pending.clear();
  ready = false;
  sending = null;
  const was = resolved;
  resolved = new Map();
  for (const id of was.keys()) for (const listener of [...(listeners.get(id) ?? [])]) listener();
}
