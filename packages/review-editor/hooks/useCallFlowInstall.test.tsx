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

function Harness({ onInstalled }: { onInstalled: () => void }) {
  const install = useCallFlowInstall(onInstalled, 10);
  return (
    <div>
      <span data-state>{install.status.state}</span>
      <span data-stage>{install.status.state === 'running' ? install.status.stage : ''}</span>
      <span data-error>{install.status.state === 'error' ? install.status.error : ''}</span>
      <button type="button" onClick={install.start}>Install</button>
    </div>
  );
}

async function render(onInstalled: () => void) {
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
    let statusPayload: CallFlowInstallStatus = { state: 'running', stage: 'downloading' };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/api/call-flow/install-status')) return jsonResponse(statusPayload);
      return jsonResponse({ state: 'running', stage: 'downloading' });
    };

    let installedCalls = 0;
    await render(() => installedCalls++);
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
    statusPayload = { state: 'running', stage: 'building' };
    for (let attempt = 0; attempt < 300 && host?.querySelector('[data-stage]')?.textContent !== 'building'; attempt++) {
      await act(async () => {
        await Bun.sleep(5);
      });
    }
    expect(host?.querySelector('[data-stage]')?.textContent).toBe('building');

    statusPayload = { state: 'done' };
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
        return jsonResponse({ state: 'done' });
      }
      return jsonResponse({ state: 'done' });
    };

    let installedCalls = 0;
    await render(() => installedCalls++);
    await clickInstall();
    await waitForState('error');
    expect(host?.querySelector('[data-error]')?.textContent).toContain('Node.js 22 or newer');
    expect(installedCalls).toBe(0);

    await clickInstall();
    await waitForState('done');
    expect(posts).toBe(2);
    expect(installedCalls).toBe(1);
  });
});
