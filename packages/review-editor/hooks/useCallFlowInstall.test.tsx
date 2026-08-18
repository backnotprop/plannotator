/**
 * DOM-gated (DOM_TESTS=1) tests for the opt-in runtime install controller.
 * Registered in .github/workflows/test.yml's UI seam-contract + DOM step.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCallFlowInstall } from './useCallFlowInstall';
import type { CallFlowInstallStatus } from '@plannotator/shared/call-flow-types';

const hasDom = typeof document !== 'undefined';
const originalFetch = globalThis.fetch;
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness({ onInstalled }: { onInstalled: () => Promise<void> }) {
  const install = useCallFlowInstall(onInstalled, 10);
  return (
    <div>
      <span data-state>{install.status.state}</span>
      <span data-stage>{install.status.state === 'running' ? install.status.stage : ''}</span>
      <span data-error>{install.status.state === 'error' ? install.status.error : ''}</span>
      <button type="button" onClick={() => install.start()}>Install</button>
    </div>
  );
}

async function render(onInstalled: () => Promise<void>) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(<Harness onInstalled={onInstalled} />);
    await Promise.resolve();
  });
}

async function clickInstall() {
  await act(async () => {
    host?.querySelector<HTMLButtonElement>('button')?.click();
    await Promise.resolve();
  });
}

async function waitForState(state: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (host?.querySelector('[data-state]')?.textContent === state) return;
    await act(async () => {
      await Bun.sleep(5);
    });
  }
  throw new Error(`Timed out waiting for install state ${state}`);
}

function jsonResponse(payload: CallFlowInstallStatus | { error: string }, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('useCallFlowInstall', () => {
  test.skipIf(!hasDom)('starts one install, polls only while running, and fires onInstalled on done', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    let statusPayload: CallFlowInstallStatus = { state: 'running', stage: 'downloading', languageIds: ['javascript-typescript'] };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/api/call-flow/install-status')) return jsonResponse(statusPayload);
      return jsonResponse({ state: 'running', stage: 'downloading', languageIds: ['javascript-typescript'] });
    };

    let installedCalls = 0;
    await render(async () => { installedCalls++; });
    expect(host?.querySelector('[data-state]')?.textContent).toBe('idle');
    // Idle never polls.
    await act(async () => {
      await Bun.sleep(40);
    });
    expect(requests).toHaveLength(0);

    await clickInstall();
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(host?.querySelector('[data-state]')?.textContent).toBe('running');

    // Polling reflects server-side stage progress.
    statusPayload = { state: 'running', stage: 'building', languageIds: ['javascript-typescript'] };
    for (let attempt = 0; attempt < 300 && host?.querySelector('[data-stage]')?.textContent !== 'building'; attempt++) {
      await act(async () => {
        await Bun.sleep(5);
      });
    }
    expect(host?.querySelector('[data-stage]')?.textContent).toBe('building');

    statusPayload = { state: 'done', languageIds: ['javascript-typescript'] };
    await waitForState('done');
    expect(installedCalls).toBe(1);

    // Polling stops once done: no further status requests arrive.
    const requestsAtDone = requests.length;
    await act(async () => {
      await Bun.sleep(50);
    });
    expect(requests.length).toBe(requestsAtDone);
    expect(installedCalls).toBe(1);
    // The whole flow issued exactly one install POST.
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  test.skipIf(!hasDom)('surfaces a failed start as error and retries with a fresh POST', async () => {
    let posts = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST') {
        posts++;
        if (posts === 1) {
          return jsonResponse({
            state: 'error',
            error: 'Call flow requires Node.js 22 or newer, which was not found on PATH.',
            reason: 'node-unavailable',
          });
        }
        return jsonResponse({ state: 'done', languageIds: ['javascript-typescript'] });
      }
      return jsonResponse({ state: 'done', languageIds: ['javascript-typescript'] });
    };

    let installedCalls = 0;
    await render(async () => { installedCalls++; });
    await clickInstall();
    await waitForState('error');
    expect(host?.querySelector('[data-error]')?.textContent).toContain('Node.js 22 or newer');
    expect(installedCalls).toBe(0);

    await clickInstall();
    await waitForState('done');
    expect(posts).toBe(2);
    expect(installedCalls).toBe(1);
  });

  test.skipIf(!hasDom)('retries the read-only advert handoff after a transient failure', async () => {
    globalThis.fetch = async () => jsonResponse({ state: 'done', languageIds: ['python'] });
    let reconciliations = 0;
    await render(async () => {
      reconciliations++;
      if (reconciliations < 3) throw new Error('transient refresh failure');
    });
    await clickInstall();
    await waitForState('done');
    for (let attempt = 0; attempt < 100 && reconciliations < 3; attempt++) {
      await act(async () => { await Bun.sleep(5); });
    }
    expect(reconciliations).toBe(3);
  });

  test.skipIf(!hasDom)('stops reconciliation after ten failures and exposes a quiet retry state', async () => {
    globalThis.fetch = async () => jsonResponse({ state: 'done', languageIds: ['python'] });
    let reconciliations = 0;
    await render(async () => {
      reconciliations++;
      throw new Error('store remains incomplete');
    });
    await clickInstall();
    await waitForState('error');
    expect(reconciliations).toBe(10);
    expect(host?.querySelector('[data-error]')?.textContent).toContain('could not be refreshed');
    await act(async () => { await Bun.sleep(30); });
    expect(reconciliations).toBe(10);
  });

  test.skipIf(!hasDom)('keeps polling after a transient non-2xx status response', async () => {
    let polls = 0;
    globalThis.fetch = async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST') {
        return jsonResponse({ state: 'running', stage: 'downloading', languageIds: ['python'] });
      }
      if (String(input).includes('/api/call-flow/install-status')) {
        polls++;
        if (polls === 1) return jsonResponse({ error: 'temporary status failure' }, 500);
        return jsonResponse({ state: 'done', languageIds: ['python'] });
      }
      return jsonResponse({ state: 'done', languageIds: ['python'] });
    };
    let installedCalls = 0;
    await render(async () => { installedCalls++; });
    await clickInstall();
    await waitForState('done');
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(installedCalls).toBe(1);
  });
});
