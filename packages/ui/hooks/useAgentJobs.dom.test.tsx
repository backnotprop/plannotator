import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentJobInfo } from '../types';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useAgentJobs') : null;

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {}
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const job: AgentJobInfo = {
  id: 'job-1',
  source: 'guide-1',
  provider: 'guide',
  label: 'Guided Review',
  status: 'running',
  startedAt: 1,
  command: ['claude', '-p'],
};

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});

describe.if(hasDom)('useAgentJobs', () => {
  test('a job that finishes before its launch response is read stays done', async () => {
    // A fast agent exits within the POST's round trip: the stream says
    // started and completed before the launch's own response ("running") is
    // read. That late copy must not put the job back to running.
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    let answerLaunch!: () => void;
    const launchAnswered = new Promise<void>((resolve) => { answerLaunch = resolve; });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        await launchAnswered;
        return Response.json({ job }, { status: 201 });
      }
      return Response.json({ providers: [] });
    }) as typeof fetch;

    let api!: ReturnType<NonNullable<typeof hookModule>['useAgentJobs']>;
    function Probe() {
      api = hookModule!.useAgentJobs();
      return null;
    }
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Probe />));
    await act(async () => FakeEventSource.last!.emit({ type: 'snapshot', jobs: [] }));

    let launched!: Promise<unknown>;
    await act(async () => { launched = api.launchJob({ provider: 'guide' }); });
    await act(async () => {
      FakeEventSource.last!.emit({ type: 'job:started', job });
      FakeEventSource.last!.emit({ type: 'job:completed', job: { ...job, status: 'done', endedAt: 2 } });
    });
    answerLaunch();
    await act(async () => { await launched; });

    expect(api.jobs.map((current) => current.status)).toEqual(['done']);
  });

  test('a launch the stream has not announced yet shows at once', async () => {
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST' ? Response.json({ job }, { status: 201 }) : Response.json({ providers: [] })) as typeof fetch;

    let api!: ReturnType<NonNullable<typeof hookModule>['useAgentJobs']>;
    function Probe() {
      api = hookModule!.useAgentJobs();
      return null;
    }
    root = createRoot(document.createElement('div'));
    await act(async () => root!.render(<Probe />));
    await act(async () => FakeEventSource.last!.emit({ type: 'snapshot', jobs: [] }));
    await act(async () => { await api.launchJob({ provider: 'guide' }); });

    expect(api.jobs.map((current) => current.status)).toEqual(['running']);
  });
});
