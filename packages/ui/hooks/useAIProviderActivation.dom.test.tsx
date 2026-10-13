import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AIProviderOption } from '../utils/aiProvider';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useAIProviderActivation') : null;

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(providers: AIProviderOption[] | undefined): (id: string) => void {
  const { useAIProviderActivation } = hookModule!;
  let activate: ((id: string) => void) | null = null;
  function Harness() {
    activate = useAIProviderActivation({ providers, onCapabilities: () => {} });
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness />));
  return (id) => activate!(id);
}

function recordFetches(): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json({ available: true, providers: [], defaultProvider: null });
  }) as typeof fetch;
  return urls;
}

const bridgeOnly: AIProviderOption[] = [
  {
    id: 'session-bridge',
    name: 'session-bridge',
    models: [],
    sessionBridge: { host: 'claude-code', status: 'ready', modes: { turn: true, transient: false } },
  },
];

describe.if(hasDom)('useAIProviderActivation', () => {
  // At page load the selection can still hold the saved cookie's id for one
  // render. On a session-bridge server that id is not offered for Ask AI, and
  // activating it would start Codex discovery anyway.
  test('never activates a provider the server does not list', () => {
    const urls = recordFetches();
    const activate = mount(bridgeOnly);
    activate('codex-sdk');
    activate('session-bridge');
    expect(urls).toEqual(['/api/ai/capabilities?activate=session-bridge']);
  });

  test('without a providers list it activates any id, as before', () => {
    const urls = recordFetches();
    const activate = mount(undefined);
    activate('codex-sdk');
    expect(urls).toEqual(['/api/ai/capabilities?activate=codex-sdk']);
  });
});
