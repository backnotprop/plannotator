import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentCapabilities, AgentJobInfo } from '../types';

const hasDom = typeof document !== 'undefined';
const tabModule = hasDom ? await import('./AgentsTab') : null;
const storage = hasDom ? await import('../utils/storage') : null;
const catalogModule = hasDom ? await import('../hooks/useModelCatalogs') : null;

const capabilities = {
  available: true,
  providers: [
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'guide', name: 'Guided Review', available: true },
  ],
} as AgentCapabilities;

const job = (over: Partial<AgentJobInfo>): AgentJobInfo => ({
  id: 'job-1',
  source: 'agent-job1',
  provider: 'claude',
  label: 'Code Review',
  status: 'done',
  startedAt: 1_000,
  endedAt: 135_000,
  command: [],
  model: 'opus',
  ...over,
}) as AgentJobInfo;

let root: Root | null = null;
let host: HTMLDivElement;
const realFetch = globalThis.fetch;

beforeEach(() => {
  if (!hasDom) return;
  const memory = new Map<string, string>();
  storage!.setStorageBackend({
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
  });
  catalogModule!.__resetModelCatalogsForTests();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/ai/capabilities')) {
      return Response.json({
        providers: [{
          id: 'claude-agent-sdk',
          modelsSource: 'discovered',
          models: [
            { id: 'opus', label: 'Opus 5.5 (latest)', reasoningEfforts: [{ id: 'high', label: 'High' }], defaultReasoningEffort: 'high' },
            { id: 'sonnet', label: 'Sonnet 5.5 (latest)', default: true, reasoningEfforts: [{ id: 'low', label: 'Low' }], defaultReasoningEffort: 'low' },
          ],
        }],
      });
    }
    if (url === '/api/agents/review-profiles') return Response.json({ profiles: [{ id: 'builtin:default', label: 'Default' }] });
    if (url === '/api/agents/guide-instructions') return Response.json({ instructions: '' });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  globalThis.fetch = realFetch;
  storage?.resetStorageBackend();
});

async function render(props: Partial<React.ComponentProps<NonNullable<typeof tabModule>['AgentsTab']>> = {}) {
  const AgentsTab = tabModule!.AgentsTab;
  root ??= createRoot(host);
  await act(async () =>
    root!.render(
      <AgentsTab
        jobs={[]}
        capabilities={capabilities}
        onLaunch={() => null}
        onKillJob={() => {}}
        onKillAll={() => {}}
        externalAnnotations={[]}
        scope="All changes since main · 3 files · +12 −4"
        {...props}
      />,
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;

describe.if(hasDom)('Agents tab launch pad', () => {
  test('one click on Start launches a guide with the defaults, with no dialog in between', async () => {
    const launched: unknown[] = [];
    await render({ onLaunch: (p) => { launched.push(p); return null; } });
    expect(q('[data-launch-scope]')!.textContent).toBe('All changes since main · 3 files · +12 −4');
    await act(async () => q('[data-launch-start="guide"]')!.click());
    expect(launched).toEqual([{ provider: 'guide', label: 'Guided Review', engine: 'claude', model: 'sonnet', effort: 'low' }]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(q('[data-launch-details]')).toBeNull();
  });

  test('details fold out in place and stay open next time', async () => {
    await render();
    const toggle = q('[data-launch-row="review"] [aria-expanded]')!;
    await act(async () => toggle.click());
    expect(q('[data-launch-details="review"]')).not.toBeNull();
    await act(async () => root!.unmount());
    root = null;
    await render();
    expect(q('[data-launch-details="review"]')).not.toBeNull();
    expect(q('[data-launch-details="guide"]')).toBeNull();
  });

  test('a finished review shows its findings by severity and a click jumps to the most severe one', async () => {
    const opened: unknown[] = [];
    await render({
      jobs: [job({})],
      externalAnnotations: [
        { id: 'n1', source: 'agent-job1', severity: 'nit', filePath: 'a.ts', lineStart: 3 },
        { id: 'i1', source: 'agent-job1', severity: 'important', filePath: 'b.ts', lineStart: 9 },
      ],
      onOpenFinding: (f) => opened.push(f.id),
    });
    const row = q('[data-agent-job-row="done"]')!;
    expect(row.textContent).toContain('Opus 5.5 (latest)');
    expect(row.textContent).toContain('2m 14s');
    expect(q('[data-agent-job-detail]')!.textContent).toBe('1 important · 1 nit');
    await act(async () => row.click());
    expect(opened).toEqual(['i1']);
  });

  test('a running job can be cancelled and a finished one run again with the same model', async () => {
    const killed: string[] = [];
    const launched: unknown[] = [];
    await render({
      jobs: [job({ id: 'run', status: 'running', endedAt: undefined }), job({ id: 'old', effort: 'high', reviewProfileId: 'skill:security' })],
      onKillJob: (id) => killed.push(id),
      onLaunch: (p) => { launched.push(p); return null; },
    });
    await act(async () => (q('[data-agent-job-row="running"] [aria-label="Cancel"]')!).click());
    await act(async () => (q('[data-agent-job-row="done"] [aria-label="Run again"]')!).click());
    expect(killed).toEqual(['run']);
    expect(launched).toEqual([{ provider: 'claude', label: 'Code Review', model: 'opus', effort: 'high', reviewProfileId: 'skill:security' }]);
  });

  test('runs read apart: the engine whole, each run its own model and effort, and its start time in the tooltip', async () => {
    await render({ jobs: [job({ id: 'a', effort: 'low' }), job({ id: 'b', effort: 'high', reviewProfileLabel: 'Security' })] });
    const rows = [...host.querySelectorAll<HTMLElement>('[data-agent-job-row]')];
    expect(rows).toHaveLength(2);
    const engines = rows.map((row) => row.querySelector('[data-agent-job-engine]')!.textContent);
    expect(engines[0]).not.toBe(engines[1]);
    expect(engines.every((text) => text!.startsWith('Claude'))).toBe(true);
    expect(rows.every((row) => !row.querySelector('[data-agent-job-engine]')!.className.includes('truncate'))).toBe(true);
    expect(rows[0].getAttribute('title')).toContain('started');
    expect(rows.map((row) => row.querySelector('[data-agent-job-label]')!.textContent)).toContain('Code Review: Security');
  });
});

