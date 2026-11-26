/**
 * When the launch dialog shows (LaunchAnnouncement.tsx), in the DOM.
 *
 * What regresses: a dialog when the claim says no, or when `shown` says another surface showed it first; the other one-time dialogs
 * not yielding while the claim is out or on the load that showed it, or held for good by a claim that never answers;
 * a claim that answers late still drawing it; the reader's first move not closing the first-run window (and that miss
 * using it up); the Inbox not waiting while something is open over the page; the VS Code webview claiming at all; an
 * answer not recorded with its campaign, or a dialog that stays after its answer. Once per computer across two
 * surfaces: packages/inbox/launchDialog.test.tsx.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { useLaunchAnnouncement } = (hasDom ? await import('./LaunchAnnouncement') : {}) as typeof import('./LaunchAnnouncement');
type LaunchClient = import('./LaunchAnnouncement').LaunchClient;
type Input = import('./LaunchAnnouncement').LaunchAnnouncementInput;

const CAMPAIGN = 'product-hunt-2026';
const URL_ = 'https://www.producthunt.com/posts/plannotator';
const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  if (hasDom) document.body.replaceChildren();
  delete (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE;
});

function Probe({ name, ...input }: Input & { name: string }) {
  const launch = useLaunchAnnouncement(input);
  return (
    <div data-probe={name} data-holds={String(launch.holds)} data-shown={String(launch.shownThisLoad)} data-open={String(launch.open)}>
      {launch.dialog}
    </div>
  );
}

async function mount(name: string, input: Input) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<Probe name={name} {...input} />));
  return {
    rerender: (next: Input) => act(async () => root.render(<Probe name={name} {...next} />)),
    probe: () => host.querySelector<HTMLElement>(`[data-probe="${name}"]`)!,
  };
}

const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const dialogs = () => document.querySelectorAll('[data-launch-dialog]').length;

function fakeClient(claim: () => Promise<unknown>, shown: () => Promise<{ show: boolean }> = async () => ({ show: true })) {
  const log: string[] = [];
  const client: LaunchClient = {
    claim: () => {
      log.push('claim');
      return claim() as ReturnType<LaunchClient['claim']>;
    },
    shown: (campaign) => {
      log.push(`shown:${campaign}`);
      return shown();
    },
    answer: async (answer, campaign) => {
      log.push(`answer:${answer}:${campaign}`);
    },
  };
  return { log, client };
}
const yes = async () => ({ show: true, campaign: CAMPAIGN, url: URL_ });

describe.skipIf(!hasDom)('useLaunchAnnouncement', () => {
  test('the claim says no: nothing is stamped or drawn, and the others go on', async () => {
    const { log, client } = fakeClient(async () => ({ show: false }));
    const s = await mount('a', { ready: true, eligible: true, firstRunWindow: true, client });
    await settle();
    expect(log).toEqual(['claim']);
    expect(dialogs()).toBe(0);
    expect(s.probe().dataset.holds).toBe('false');
  });

  test('the claim says yes: stamped, drawn, the others held for the rest of the load; Not now records dismissed', async () => {
    const { log, client } = fakeClient(yes);
    const s = await mount('a', { ready: true, eligible: true, firstRunWindow: true, client });
    await settle();
    expect(log).toEqual(['claim', `shown:${CAMPAIGN}`]);
    expect(dialogs()).toBe(1);
    expect(s.probe().dataset.holds).toBe('true');
    await act(async () => document.querySelector<HTMLElement>('[data-launch-not-now]')!.click());
    await settle();
    expect(log.at(-1)).toBe(`answer:dismissed:${CAMPAIGN}`);
    expect(dialogs()).toBe(0);
    expect([s.probe().dataset.holds, s.probe().dataset.shown, s.probe().dataset.open]).toEqual(['true', 'true', 'false']);
  });

  test('shown says no (another surface showed it first): nothing draws and the others go on', async () => {
    const { client } = fakeClient(yes, async () => ({ show: false }));
    const s = await mount('a', { ready: true, eligible: true, firstRunWindow: true, client });
    await settle();
    expect(dialogs()).toBe(0);
    expect(s.probe().dataset.holds).toBe('false');
  });

  test('the others wait while the claim is out, but never past the wait, and a late yes draws nothing', async () => {
    let answer: (v: unknown) => void = () => {};
    const { log, client } = fakeClient(() => new Promise((r) => (answer = r)));
    const s = await mount('a', { ready: true, eligible: true, firstRunWindow: true, client, claimWaitMs: 40 });
    await settle(5);
    expect(s.probe().dataset.holds).toBe('true');
    await settle(60);
    expect(s.probe().dataset.holds).toBe('false');
    await act(async () => answer({ show: true, campaign: CAMPAIGN, url: URL_ }));
    await settle();
    expect(dialogs()).toBe(0);
    expect(log).toEqual(['claim']);
  });

  test('not before the page is ready or while the host gates fail, and never in the VS Code webview', async () => {
    const { log, client } = fakeClient(yes);
    const s = await mount('a', { ready: false, eligible: true, firstRunWindow: true, client });
    await s.rerender({ ready: true, eligible: false, firstRunWindow: true, client });
    await settle();
    expect(log).toEqual([]);
    (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE = true;
    await s.rerender({ ready: true, eligible: true, firstRunWindow: true, client });
    await settle();
    expect(log).toEqual([]);
    expect(dialogs()).toBe(0);
    expect(s.probe().dataset.holds).toBe('false');
  });

  test('the reader moved before it could open: missed for this load, and nothing used up', async () => {
    let answer: (v: unknown) => void = () => {};
    const { log, client } = fakeClient(() => new Promise((r) => (answer = r)));
    await mount('a', { ready: true, eligible: true, firstRunWindow: true, client });
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })));
    await act(async () => answer({ show: true, campaign: CAMPAIGN, url: URL_ }));
    await settle();
    expect(dialogs()).toBe(0);
    expect(log).toEqual(['claim']);
  });

  test('without the first-run window (the Inbox): it waits while something is over the page, then opens', async () => {
    const { log, client } = fakeClient(yes);
    const s = await mount('inbox', { ready: true, eligible: true, firstRunWindow: false, blocked: true, client });
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })));
    await settle();
    expect(dialogs()).toBe(0);
    await s.rerender({ ready: true, eligible: true, firstRunWindow: false, blocked: false, client });
    await settle();
    expect(dialogs()).toBe(1);
    expect(log).toEqual(['claim', `shown:${CAMPAIGN}`]);
  });
});
