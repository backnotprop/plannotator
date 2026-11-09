/**
 * The face each agent's mark shows (approval "inbox-agent-icon-motion", the owner 2026-11-09: a swapped icon never
 * goes back by itself, "it stays until clicked"). Kept for this browser in localStorage, by the agent's id (a launch
 * keeps its id while its session changes), so a reload keeps it too. At most FACES_KEPT agents, the latest click last;
 * the agent's own mark is never stored.
 */
import { useSyncExternalStore } from 'react';
import { AGENT_FACES, type AgentFace } from './motion';

export const AGENT_FACES_KEY = 'plannotator-inbox-agent-faces';
export const FACES_KEPT = 200;

const listeners = new Set<() => void>();
let cache: Record<string, AgentFace> | null = null;

function read(): Record<string, AgentFace> {
  if (cache) return cache;
  let raw: unknown = null;
  try {
    raw = JSON.parse(window.localStorage.getItem(AGENT_FACES_KEY) ?? '{}');
  } catch {
    raw = null;
  }
  const out: Record<string, AgentFace> = {};
  if (raw && typeof raw === 'object') {
    for (const [id, face] of Object.entries(raw as Record<string, unknown>)) {
      if (face !== 'agent' && AGENT_FACES.includes(face as AgentFace)) out[id] = face as AgentFace;
    }
  }
  cache = out;
  return out;
}

/** The face kept for an agent; the agent's own mark when none is. */
export function agentFaceOf(id: string): AgentFace {
  return read()[id] ?? 'agent';
}

/** Keep a face for an agent (its own mark: forget it). */
export function keepAgentFace(id: string, face: AgentFace): void {
  const next = { ...read() };
  delete next[id];
  if (face !== 'agent') next[id] = face;
  const ids = Object.keys(next);
  for (const old of ids.slice(0, Math.max(0, ids.length - FACES_KEPT))) delete next[old];
  cache = next;
  try {
    window.localStorage.setItem(AGENT_FACES_KEY, JSON.stringify(next));
  } catch {
    // Storage full or off: the face still shows on this page.
  }
  for (const listener of [...listeners]) listener();
}

/** Forget what was read (tests). */
export function resetAgentFaces(): void {
  cache = null;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The face kept for an agent, redrawn when a click changes it. */
export function useAgentFace(id: string): AgentFace {
  return useSyncExternalStore(
    subscribe,
    () => agentFaceOf(id),
    () => 'agent',
  );
}
