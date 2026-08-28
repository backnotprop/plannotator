/**
 * ApproveDropdown's "current model" preview: the split button and the
 * "Keep current model" menu item must show the real model id when the host
 * supplies one, and fall back to the old generic text when it doesn't
 * (older OpenCode hosts, or the lookup failing server-side).
 */
import React, { act } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { resetStorageBackend, setStorageBackend, type StorageBackend } from '../utils/storage';
import { ApproveDropdown } from './ApproveDropdown';
import type { Agent } from '../hooks/useAgents';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function memoryStorage(): StorageBackend {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const AGENTS: Agent[] = [
  { id: 'build', name: 'build', model: { providerID: 'openai', modelID: 'gpt-5.6-terra' } },
  { id: 'plan', name: 'plan', model: { providerID: 'openai', modelID: 'gpt-5.6-sol' } },
];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  resetStorageBackend();
});

function render(props: Partial<React.ComponentProps<typeof ApproveDropdown>> = {}) {
  setStorageBackend(memoryStorage());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ApproveDropdown
        onApprove={() => {}}
        agents={AGENTS}
        {...props}
      />,
    );
  });
  return container;
}

describe.if(hasDom)('ApproveDropdown current model preview', () => {
  test('shows the real model id in the split button when known', () => {
    const el = render({ currentModel: { providerID: 'openai', modelID: 'gpt-5.6-terra' } });
    expect(el.textContent).toContain('gpt-5.6-terra');
    expect(el.textContent).not.toContain('current model');
  });

  test('falls back to the generic label when the current model is unknown', () => {
    const el = render();
    expect(el.textContent).toContain('current model');
  });

  test('the "Keep current model" menu item shows the resolved model id', () => {
    const el = render({ currentModel: { providerID: 'openai', modelID: 'gpt-5.6-terra' } });
    const toggle = el.querySelectorAll('button')[2] as HTMLButtonElement;
    act(() => toggle.click());

    const keepCurrent = Array.from(el.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('Keep current model'));
    expect(keepCurrent?.textContent).toContain('gpt-5.6-terra');
  });
});
