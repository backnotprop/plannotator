/**
 * Cookie-only preference for the Mermaid-syntax diagram renderer.
 *
 * Keep this out of the settings registry: that registry is embedded into the
 * pinned guides.show viewer. The external-store snapshot is a string, so it is
 * stable across reads and safe for useSyncExternalStore.
 */
import { getItem, setItem } from './storage';

export type DiagramEngine = 'mermaid' | 'pele';

const STORAGE_KEY = 'plannotator-diagram-engine';
const DEFAULT_ENGINE: DiagramEngine = 'mermaid';
const listeners = new Set<() => void>();

export function parseDiagramEngine(value: string | null | undefined): DiagramEngine {
  return value === 'pele' ? 'pele' : DEFAULT_ENGINE;
}

export function getDiagramEngine(): DiagramEngine {
  return parseDiagramEngine(getItem(STORAGE_KEY));
}

export function setDiagramEngine(engine: DiagramEngine): void {
  const normalized = parseDiagramEngine(engine);
  if (getDiagramEngine() === normalized) return;
  setItem(STORAGE_KEY, normalized);
  for (const listener of listeners) listener();
}

export function subscribeDiagramEngine(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
