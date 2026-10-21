import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from './storage';
import { getDiagramEngine, parseDiagramEngine, setDiagramEngine, subscribeDiagramEngine } from './diagramEngine';

const store = new Map<string, string>();
const key = 'plannotator-diagram-engine';

afterEach(() => {
  store.clear();
  resetStorageBackend();
});

describe('diagram renderer preference', () => {
  test('defaults to Mermaid for absent and invalid cookie values', () => {
    expect(parseDiagramEngine(null)).toBe('mermaid');
    expect(parseDiagramEngine('unexpected')).toBe('mermaid');
    expect(parseDiagramEngine('pele')).toBe('pele');
  });

  test('persists through the storage backend and notifies mounted readers', () => {
    setStorageBackend({
      getItem: (item) => store.get(item) ?? null,
      setItem: (item, value) => { store.set(item, value); },
      removeItem: (item) => { store.delete(item); },
    });
    const seen: string[] = [];
    const unsubscribe = subscribeDiagramEngine(() => seen.push(getDiagramEngine()));

    setDiagramEngine('pele');
    expect(store.get(key)).toBe('pele');
    expect(getDiagramEngine()).toBe('pele');
    expect(seen).toEqual(['pele']);

    setDiagramEngine('mermaid');
    expect(store.get(key)).toBe('mermaid');
    expect(seen).toEqual(['pele', 'mermaid']);
    unsubscribe();
  });
});
