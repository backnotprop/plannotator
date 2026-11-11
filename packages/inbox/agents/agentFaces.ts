/**
 * The face each agent's icon shows, everywhere it is drawn (approval "inbox-agent-icon-motion": a swapped icon never
 * goes back by itself). The one owner of the choice in the window: the sidebar's Agents picker writes it, and every
 * icon that knows an agent (a list row's tiles, a message's author, the reply box's recipient, the starred pills, New
 * message's To; icons.tsx `HostMark`'s `agent`) reads it by whatever id it has, a session id or an `InboxAgent.id`.
 *
 * The Inbox keeps it (`GET`/`POST /api/inbox/agent-faces`, core inbox-types.ts, "Agent faces"), so every window, the phone's
 * and the iPad's, shows the same face, and every window open takes a save at once (`event: agent-faces`). An entry
 * is an agent's id (a launch's, else its session's) with every session it was or is, so an icon finds it by any of
 * them; the agents' list adds the sessions a live agent is now (a launch that started, a conversation that went on).
 *
 * This page: what the server said last (kept with this page's changes in `plannotator-inbox-agent-faces-v2`, so a
 * reload paints the faces before the read answers; never the truth), this page's own changes until the server answers them, and the agents'
 * list. Folded into one map of id → face, rebuilt on each change (a few hundred entries at most); only the icons whose
 * face changed hear of it (one listener set per id), so a choice redraws its agent's icons and nothing else.
 *
 * The faces this browser kept before the Inbox kept them (`plannotator-inbox-agent-faces`) show at once and are sent
 * once (`adopt`): the old key goes only when the server has them.
 */
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

/** This browser's faces from before the Inbox kept them: `{ [agent id]: face }`. */
export const AGENT_FACES_KEY = 'plannotator-inbox-agent-faces';
/** The paint copy: the last `{ faces, rev }` this page had. */
export const AGENT_FACES_PAINT_KEY = 'plannotator-inbox-agent-faces-v2';

/** An agent as a choice names it: its id, and the sessions it is (an `InboxAgent`, or only an id). */
export type AgentFaceRef = string | Pick<InboxAgent, 'id' | 'session' | 'continues'>;

type Entries = Record<string, InboxAgentFaceEntry>;
/** A face an icon shows in place of the agent's own mark: one of ours, or an uploaded picture. */
type Shown = Exclude<AgentFace, 'agent'>;

let server: { faces: Entries; rev: number } | null = null;
/** Faces of this browser from before, not yet taken by the server. */
let legacy: Record<string, OurFace> | null = null;
/** This page's changes the server has not answered yet, the latest last. */
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

/** The entries as this page shows them: the server's, then this browser's old ones it lacks, then this page's changes. */
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
    // An uploaded picture this Inbox does not keep (removed, or chosen on another machine): the agent's own mark.
    if (entry.face.startsWith('own:') && !ownFaceShows(entry.face)) continue;
    next.set(key, entry.face);
    for (const session of entry.sessions) next.set(session, entry.face);
  }
  // A listed agent is every id of its chain: a launch's session, the session a conversation went on as.
  const direct = new Map(next);
  for (const agent of inboxAgentsFlat(inboxAgentsNow())) {
    const chain = chainOf(agent);
    const face = chain.map((id) => direct.get(id)).find((found) => found !== undefined);
    if (face) for (const id of chain) if (!direct.has(id)) next.set(id, face);
  }
  const was = resolved;
  resolved = next;
  // Our faces' pictures load only when one is shown (an uploaded picture or a set icon needs none of them).
  if ([...next.values()].some((face) => !face.startsWith('own:') && !face.startsWith('set:'))) void loadAgentFaceArt().catch(() => {});
  const changed = new Set<string>();
  for (const [id, face] of next) if (was.get(id) !== face) changed.add(id);
  for (const id of was.keys()) if (!next.has(id)) changed.add(id);
  for (const id of changed) for (const listener of [...(listeners.get(id) ?? [])]) listener();
}

/** The paint copy: the server's faces with this page's changes on them, so a reload shows a choice even before it is saved. */
function keepPaint(): void {
  try {
    if (server || pending.size > 0) window.localStorage.setItem(AGENT_FACES_PAINT_KEY, JSON.stringify({ faces: entries(false), rev: server?.rev ?? 0, ...(ownIconsNow() ? { icons: ownIconsNow() } : {}) }));
  } catch {
    // Storage full or off: a reload paints the plain marks until the read answers.
  }
}

/** The server's faces (a read's answer, a save's answer, an event). `force`: a read, which is the truth whatever its count. */
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

/** The face kept for an agent, by any id it has (a session id, an `InboxAgent.id`); its own mark when none is. */
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
      // Not saved (offline, an Inbox from before faces): shown on this page, not sent again, until a read says otherwise.
    }
  }
}
const sentNow = new WeakSet<object>();

/** Keep a face for an agent (its own mark: forget it): every icon of it redraws at once, then the Inbox keeps it. */
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

/**
 * "Your own…": keep a picked, dropped or pasted picture with the Inbox, then show it on this agent at once. Answers
 * null, or the words a refusal shows (the same as Set picture…'s: too big, not one of the five types).
 */
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

/** Take an uploaded picture away: every agent showing it goes back to its own mark, in every window. */
export async function removeOwnPicture(id: string): Promise<string | null> {
  boot();
  try {
    hear(await inboxApi.removeAgentIcon(id), false);
    return null;
  } catch (cause) {
    return errorText(cause, 'The picture did not change.');
  }
}

/** The page read the faces (on load, and again after its stream was away). Then this browser's old faces go up, once. */
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
      // Kept: sent again next time, and the server keeps a choice it has.
    }
    if (!hear(adopted, true)) rebuild();
  } catch {
    // Kept here and in this browser until a read that can take them.
  }
}

/** Another window's save (`event: agent-faces`). */
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

/** The face kept for an agent, redrawn only when its own face changes; its own mark for no id. */
export function useAgentFace(id: string | null | undefined): AgentFace {
  const subscribe = useCallback((listener: () => void) => (id ? subscribeTo(id, listener) : nothing()), [id]);
  return useSyncExternalStore(subscribe, () => agentFaceOf(id), plain);
}

/** Tests: forget everything this page had and read the browser again. */
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
