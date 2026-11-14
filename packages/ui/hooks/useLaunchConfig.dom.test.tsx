import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentCapabilities } from '../types';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useLaunchConfig') : null;
const storage = hasDom ? await import('../utils/storage') : null;
const catalogModule = hasDom ? await import('./useModelCatalogs') : null;

type Config = ReturnType<NonNullable<typeof hookModule>['useLaunchConfig']>;

const claudeModels = [
  { id: 'opus', label: 'Opus 5.5 (latest)', resolvedId: 'claude-opus-5-5', reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultReasoningEffort: 'high' },
  { id: 'sonnet', label: 'Sonnet 5.5 (latest)', default: true, reasoningEfforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], defaultReasoningEffort: 'high' },
];

const capabilities: AgentCapabilities = {
  available: true,
  providers: [
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'guide', name: 'Guided Review', available: true },
  ],
} as AgentCapabilities;

let latest: Config | null = null;
function Harness() {
  latest = hookModule!.useLaunchConfig(capabilities);
  return null;
}

let root: Root | null = null;
let memory = new Map<string, string>();
const realFetch = globalThis.fetch;

beforeEach(() => {
  if (!hasDom) return;
  memory = new Map();
  storage!.setStorageBackend({
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
  });
  catalogModule!.__resetModelCatalogsForTests();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/ai/capabilities')) {
      return Response.json({ providers: [{ id: 'claude-agent-sdk', models: claudeModels, modelsSource: 'discovered', toolVersion: '2.1.323' }] });
    }
    if (url === '/api/agents/review-profiles') return Response.json({ profiles: [{ id: 'builtin:default', label: 'Default', default: true }] });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  globalThis.fetch = realFetch;
  storage?.resetStorageBackend();
});

async function mount() {
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(<Harness />));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe.if(hasDom)('launch pad defaults', () => {
  test('with nothing saved, one click launches a guide on Sonnet at low effort and a review on Opus at high', async () => {
    await mount();
    expect(latest!.guide.ready).toBe(true);
    expect(latest!.review.ready).toBe(true);
    expect(latest!.guide.buildParams()).toEqual({ provider: 'guide', label: 'Guided Review', engine: 'claude', model: 'sonnet', effort: 'low' });
    expect(latest!.review.buildParams()).toEqual({ provider: 'claude', label: 'Code Review', model: 'opus', effort: 'high' });
    expect(latest!.guide.summary).toBe('Claude · Sonnet 5.5 (latest) · Low');
    expect(latest!.guide.notice).toBeNull();
  });

  test('a choice made in the details is remembered for the next window', async () => {
    await mount();
    await act(async () => latest!.review.setModel('sonnet'));
    await act(async () => latest!.review.setEffort('low'));
    await act(async () => root!.unmount());
    await mount();
    expect(latest!.review.buildParams()).toEqual({ provider: 'claude', label: 'Code Review', model: 'sonnet', effort: 'low' });
  });

  test('a saved model the installed CLI no longer offers falls back to its family and says so once', async () => {
    storage!.setItem('plannotator.agents', JSON.stringify({ guideClaude: { model: 'claude-opus-4-1', perModel: {} } }));
    await mount();
    expect(latest!.guide.model).toBe('opus');
    expect(latest!.guide.notice).toBe("claude-opus-4-1 isn't offered by Claude any more. Using Opus 5.5 (latest).");
    expect(latest!.guide.buildParams().model).toBe('opus');
  });

  test('instructions typed in the guide details ride the launch', async () => {
    await mount();
    expect(latest!.guide.buildParams({ instructions: '  name the risky files first ' }).instructions).toBe('name the risky files first');
    expect('instructions' in latest!.review.buildParams({ instructions: 'x' })).toBe(false);
  });
});
