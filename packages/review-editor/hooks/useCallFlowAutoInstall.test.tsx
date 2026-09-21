/** DOM-gated contract tests for one-shot Call flow background installation. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CallFlowAdvert, CallFlowInstallStatus } from '@plannotator/shared/call-flow-types';
import type { CallFlowLanguageId } from '@plannotator/shared/call-flow-languages';
import { useCallFlowInstall } from './useCallFlowInstall';
import { useCallFlowAutoInstall } from './useCallFlowAutoInstall';

const hasDom = typeof document !== 'undefined';
const originalFetch = globalThis.fetch;
let host: HTMLDivElement | null = null;
let root: Root | null = null;

function advert(
  languageIds: CallFlowLanguageId[],
  overrides: Partial<CallFlowAdvert> = {},
): CallFlowAdvert {
  return {
    enabled: true,
    available: languageIds[0] !== 'javascript-typescript',
    state: languageIds[0] === 'javascript-typescript' ? 'unavailable' : 'available',
    provider: 'calldiff',
    installable: true,
    installPlan: {
      languageIds,
      labels: languageIds,
      changedFiles: 1,
      installSizeBytes: languageIds.length * 1024 * 1024,
    },
    ...overrides,
  };
}

function Harness({
  enabled,
  consentAcknowledged,
  capability,
  onInstalled,
}: {
  enabled: boolean;
  consentAcknowledged: boolean;
  capability: CallFlowAdvert;
  onInstalled: () => Promise<void>;
}) {
  const install = useCallFlowInstall(onInstalled, 10);
  useCallFlowAutoInstall(enabled, consentAcknowledged, capability, install);
  return (
    <div>
      <span data-state>{install.status.state}</span>
      <button type="button" onClick={() => install.start(install.status.state === 'error' ? install.status.languageIds : undefined)}>
        Retry
      </button>
    </div>
  );
}

async function render(
  enabled: boolean,
  capability: CallFlowAdvert,
  onInstalled: () => Promise<void>,
  consentAcknowledged = true,
) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(
      <Harness
        enabled={enabled}
        consentAcknowledged={consentAcknowledged}
        capability={capability}
        onInstalled={onInstalled}
      />,
    );
    await Promise.resolve();
  });
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await act(async () => { await Bun.sleep(5); });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function jsonResponse(payload: CallFlowInstallStatus): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
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

describe('useCallFlowAutoInstall', () => {
  test.skipIf(!hasDom)('starts each target once per review session across toggle cycles', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ state: 'done', languageIds: ['javascript-typescript'] });
    };
    const onInstalled = async () => {};
    const plan = advert(['javascript-typescript']);

    await render(false, { ...plan, enabled: false, state: 'disabled' }, onInstalled);
    expect(bodies).toHaveLength(0);
    await render(true, plan, onInstalled);
    await waitFor(() => bodies.length === 1, 'first automatic install');
    await render(true, { ...plan, installPlan: { ...plan.installPlan! } }, onInstalled);
    expect(bodies).toHaveLength(1);

    await render(false, { ...plan, enabled: false, state: 'disabled' }, onInstalled);
    await render(true, plan, onInstalled);
    await act(async () => { await Bun.sleep(30); });
    expect(bodies).toEqual([{ languageIds: ['javascript-typescript'] }]);
  });

  test.skipIf(!hasDom)('waits for the updated consent dialog acknowledgment', async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ state: 'done', languageIds: ['python'] });
    };
    const plan = advert(['python']);

    await render(true, plan, async () => {}, false);
    await act(async () => { await Bun.sleep(30); });
    expect(bodies).toHaveLength(0);

    await render(true, plan, async () => {}, true);
    await waitFor(() => bodies.length === 1, 'install after consent acknowledgment');
    expect(bodies).toEqual([{ languageIds: ['python'] }]);
  });

  test.skipIf(!hasDom)('installs a newly required language and reconciles analysis in session', async () => {
    const bodies: unknown[] = [];
    let reconciliations = 0;
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { languageIds: CallFlowLanguageId[] };
      bodies.push(body);
      return jsonResponse({ state: 'done', languageIds: body.languageIds });
    };
    const onInstalled = async () => { reconciliations++; };

    await render(true, advert(['python']), onInstalled);
    await waitFor(() => reconciliations === 1, 'Python analysis reconciliation');
    await render(true, advert(['go']), onInstalled);
    await waitFor(() => reconciliations === 2, 'Go analysis reconciliation');

    expect(bodies).toEqual([
      { languageIds: ['python'] },
      { languageIds: ['go'] },
    ]);
  });

  test.skipIf(!hasDom)('does not loop after failure and retries only on explicit action', async () => {
    let posts = 0;
    globalThis.fetch = async () => {
      posts++;
      return jsonResponse({ state: 'error', error: 'offline', languageIds: ['python'] });
    };
    const plan = advert(['python']);
    const onInstalled = async () => {};

    await render(true, plan, onInstalled);
    await waitFor(() => host?.querySelector('[data-state]')?.textContent === 'error', 'install error');
    await render(true, { ...plan, installPlan: { ...plan.installPlan! } }, onInstalled);
    await act(async () => { await Bun.sleep(30); });
    expect(posts).toBe(1);

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button')?.click();
      await Promise.resolve();
    });
    await waitFor(() => posts === 2, 'explicit retry');
  });

  test.skipIf(!hasDom)('attempts a newly required target after an earlier target fails', async () => {
    const bodies: Array<{ languageIds: CallFlowLanguageId[] }> = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { languageIds: CallFlowLanguageId[] };
      bodies.push(body);
      return jsonResponse(body.languageIds.includes('python')
        ? { state: 'error', error: 'Python install failed.', languageIds: body.languageIds, currentLanguageId: 'python' }
        : { state: 'done', languageIds: body.languageIds });
    };

    await render(true, advert(['python']), async () => {});
    await waitFor(() => host?.querySelector('[data-state]')?.textContent === 'error', 'Python failure');
    await render(true, advert(['go']), async () => {});
    await waitFor(() => bodies.length === 2, 'Go automatic install');
    await render(true, { ...advert(['go']), installPlan: { ...advert(['go']).installPlan! } }, async () => {});
    await act(async () => { await Bun.sleep(30); });

    expect(bodies).toEqual([
      { languageIds: ['python'] },
      { languageIds: ['go'] },
    ]);
  });

  test.skipIf(!hasDom)('filters a failed target out of a mixed plan and starts only the new target', async () => {
    const bodies: Array<{ languageIds: CallFlowLanguageId[] }> = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { languageIds: CallFlowLanguageId[] };
      bodies.push(body);
      return jsonResponse(body.languageIds.includes('python')
        ? { state: 'error', error: 'Python install failed.', languageIds: body.languageIds, currentLanguageId: 'python' }
        : { state: 'done', languageIds: body.languageIds });
    };

    await render(true, advert(['python']), async () => {});
    await waitFor(() => host?.querySelector('[data-state]')?.textContent === 'error', 'Python failure');
    await render(true, advert(['python', 'go']), async () => {});
    await waitFor(() => bodies.length === 2, 'mixed-plan Go install');

    expect(bodies).toEqual([
      { languageIds: ['python'] },
      { languageIds: ['go'] },
    ]);
  });

  test.skipIf(!hasDom)('gives a queued target its own attempt when an earlier pack in the flight fails', async () => {
    const bodies: Array<{ languageIds: CallFlowLanguageId[] }> = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { languageIds: CallFlowLanguageId[] };
      bodies.push(body);
      return jsonResponse(body.languageIds.includes('python')
        ? {
            state: 'error',
            error: 'Python install failed.',
            languageIds: body.languageIds,
            currentLanguageId: 'python',
          }
        : { state: 'done', languageIds: body.languageIds });
    };

    await render(true, advert(['python', 'go']), async () => {});
    await waitFor(() => bodies.length === 2, 'queued Go attempt');
    expect(bodies).toEqual([
      { languageIds: ['python', 'go'] },
      { languageIds: ['go'] },
    ]);
  });

  test.skipIf(!hasDom)('never installs for an override or other unmanaged runtime', async () => {
    let posts = 0;
    globalThis.fetch = async () => {
      posts++;
      return jsonResponse({ state: 'done', languageIds: ['python'] });
    };
    await render(true, advert(['python'], { installable: false }), async () => {});
    await act(async () => { await Bun.sleep(30); });
    expect(posts).toBe(0);
  });
});
