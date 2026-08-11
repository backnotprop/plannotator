import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCallFlowAnalysis } from './useCallFlowAnalysis';

const hasDom = typeof document !== 'undefined';
const originalFetch = globalThis.fetch;
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const okPayload = {
  status: 'ok' as const,
  snapshotId: 'snapshot',
  provider: 'calldiff' as const,
  version: '0.4.1',
  from: 'before',
  to: 'after',
  raw: '',
  trees: [],
  fileImpacts: {},
  summary: { entries: 0, changedNodes: 0, added: 0, removed: 0, impactedFiles: 0, warnings: 0 },
  diagnostics: [],
  skippedLanguages: [],
};

function Harness({ snapshotId }: { snapshotId: string }) {
  const analysis = useCallFlowAnalysis(snapshotId, true);
  return (
    <div>
      <span data-status>{analysis.state.status}</span>
      <button type="button" onClick={analysis.retry}>Retry</button>
    </div>
  );
}

async function render(snapshotId = 'snapshot') {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(<Harness snapshotId={snapshotId} />);
    await Promise.resolve();
  });
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('useCallFlowAnalysis', () => {
  test.skipIf(!hasDom)('keeps one request per snapshot and retries an error on demand', async () => {
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      requested.push(String(input));
      const payload = requested.length === 1
        ? { status: 'error', reason: 'analysis-failed', message: 'temporary failure' }
        : okPayload;
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    };

    await render();
    expect(host?.querySelector('[data-status]')?.textContent).toBe('error');
    expect(requested).toHaveLength(1);

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button')?.click();
      await Promise.resolve();
    });
    expect(host?.querySelector('[data-status]')?.textContent).toBe('ready');
    expect(requested).toHaveLength(2);
    expect(requested[0]).toContain('snapshot=snapshot&attempt=0');
    expect(requested[1]).toContain('snapshot=snapshot&attempt=1');
  });

  test.skipIf(!hasDom)('aborts the previous request when the review snapshot changes', async () => {
    const signals: AbortSignal[] = [];
    globalThis.fetch = (_input, init) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      if (signals.length === 1) return new Promise<Response>(() => {});
      return Promise.resolve(new Response(JSON.stringify(okPayload)));
    };

    await render('old');
    await render('current');

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(host?.querySelector('[data-status]')?.textContent).toBe('ready');
  });
});
