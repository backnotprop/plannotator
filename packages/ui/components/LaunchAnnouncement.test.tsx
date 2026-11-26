/**
 * When the launch dialog shows (LaunchAnnouncement.tsx), in the DOM.
 *
 * What regresses: a dialog when the claim says no, or one that stays when `shown` says another surface stamped it first;
 * `shown` posted before the dialog painted (a dialog that never drew, stamped as seen); a dialog file that cannot load,
 * or a dialog that throws, taking the page down or stamping it; the art deciding the layout after the dialog opened;
 * the other one-time dialogs not yielding while the claim is out or on the load that showed it, or held for good by a
 * claim that never answers; a claim that answers late still drawing it where the first-run window applies (the Inbox
 * takes it); a yes that waited long not asked again; the reader's first move not closing the first-run window (and
 * that miss using it up); the Inbox not waiting while something is open over the page; the VS Code panel left out
 * (the owner wants it there too); an answer not recorded with its campaign, or a dialog that stays after its answer. Once per computer across two
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
  const launch = useLaunchAnnouncement({ loadArt: async () => true, ...input });
  return (
    <div data-probe={name} data-holds={String(launch.holds)} data-shown={String(launch.shownThisLoad)} data-open={String(launch.open)}>
      <p data-page-content>The plan under review</p>
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

const settle = (ms = 60) => act(async () => new Promise((r) => setTimeout(r, ms)));
const dialogs = () => document.querySelectorAll('[data-launch-dialog]').length;

function fakeClient(claim: () => Promise<unknown>, shown: () => Promise<{ show: boolean }> = async () => ({ show: true })) {
  const log: string[] = [];
  const client: LaunchClient = {
    claim: () => {
      log.push('claim');
      return claim() as ReturnType<LaunchClient['claim']>;
    },
    shown: (campaign) => {
      log.push(`shown:${campaign}:${dialogs() === 1 ? 'painted' : 'unpainted'}`);
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
    await settle(500); // the dialog's own file loads first
    await settle();
    expect(log).toEqual(['claim', `shown:${CAMPAIGN}:painted`]);
    expect(dialogs()).toBe(1);
    expect(s.probe().dataset.holds).toBe('true');
    await act(async () => document.querySelector<HTMLElement>('[data-launch-not-now]')!.click());
    await settle();
    expect(log.at(-1)).toBe(`answer:dismissed:${CAMPAIGN}`);
    expect(dialogs()).toBe(0);
    expect([s.probe().dataset.holds, s.probe().dataset.shown, s.probe().dataset.open]).toEqual(['true', 'true', 'false']);
  });

  test('shown says no (another surface stamped it at the same moment): it closes and the others go on', async () => {
    const { log, client } = fakeClient(yes, async () => ({ show: false }));
    const s = await mount('a', { ready: true, eligible: true, firstRunWindow: true, client });
    await settle();
    expect(log).toEqual(['claim', `shown:${CAMPAIGN}:painted`]);
    expect(dialogs()).toBe(0);
    expect(s.probe().dataset.holds).toBe('false');
  });

  test("the dialog's own file is asked for only once a claim says yes, never on a no", async () => {
    const asked: string[] = [];
    const load = () => (asked.push('load'), import('./LaunchDialog').then((m) => m.LaunchDialog));
    const no = fakeClient(async () => ({ show: false }));
    await mount('no', { ready: true, eligible: true, firstRunWindow: true, client: no.client, loadDialog: load });
    await settle();
    expect(asked).toEqual([]);
    let answer: (v: unknown) => void = () => {};
    const later = fakeClient(() => new Promise((r) => (answer = r)));
    await mount('yes', { ready: true, eligible: true, firstRunWindow: false, client: later.client, loadDialog: load });
    await settle();
    expect(asked).toEqual([]);
    await act(async () => answer({ show: true, campaign: CAMPAIGN, url: URL_ }));
    await settle();
    expect(asked).toEqual(['load']);
  });

  test('a dialog file that cannot load: nothing shows, nothing is stamped, the page stays, the others go on', async () => {
    const { log, client } = fakeClient(yes);
    const s = await mount('a', { ready: true, eligible: true, firstRunWindow: true, client, loadDialog: () => Promise.reject(new Error('Failed to fetch dynamically imported module')) });
    await settle();
    expect(log).toEqual(['claim']);
    expect(dialogs()).toBe(0);
    expect(s.probe().querySelector('[data-page-content]')?.textContent).toBe('The plan under review');
    expect(s.probe().dataset.holds).toBe('false');
  });

  test('a dialog that throws as it draws: caught in its own boundary, the page stays, nothing is stamped', async () => {
    const { log, client } = fakeClient(yes);
    const quiet = console.error;
    console.error = () => {};
    try {
      const Broken = () => {
        throw new Error('broken dialog');
      };
      const s = await mount('a', { ready: true, eligible: true, firstRunWindow: true, client, loadDialog: async () => Broken });
      await settle();
      expect(log).toEqual(['claim']);
      expect(s.probe().querySelector('[data-page-content]')?.textContent).toBe('The plan under review');
      expect(document.querySelector('[data-lazy-load-failed]')).toBeNull();
      expect(s.probe().dataset.open).toBe('false');
    } finally {
      console.error = quiet;
    }
  });

  test('the art decides the layout before it opens: it waits for the art, then opens with it or with its words alone', async () => {
    let artIn: (ok: boolean) => void = () => {};
    const { client } = fakeClient(yes);
    await mount('a', { ready: true, eligible: true, firstRunWindow: true, client, loadArt: () => new Promise((r) => (artIn = r)) });
    await settle();
    expect(dialogs()).toBe(0);
    await act(async () => artIn(false));
    await settle();
    expect(document.querySelector('[data-launch-dialog]')?.getAttribute('data-launch-art')).toBe('gone');
    expect(document.querySelector('[data-launch-dialog] img')).toBeNull();
  });

  test('a yes that waited long is asked again before it opens; a no then draws nothing', async () => {
    let calls = 0;
    const { log, client } = fakeClient(async () => (calls++ === 0 ? { show: true, campaign: CAMPAIGN, url: URL_ } : { show: false }));
    const s = await mount('inbox', { ready: true, eligible: true, firstRunWindow: false, blocked: true, client, reclaimAfterMs: 0 });
    await settle();
    await s.rerender({ ready: true, eligible: true, firstRunWindow: false, blocked: false, client, reclaimAfterMs: 0 });
    await settle();
    expect(log).toEqual(['claim', 'claim']);
    expect(dialogs()).toBe(0);
  });

  test('the Inbox (no first-run window) takes a yes that answers after the wait', async () => {
    let answer: (v: unknown) => void = () => {};
    const { log, client } = fakeClient(() => new Promise((r) => (answer = r)));
    await mount('inbox', { ready: true, eligible: true, firstRunWindow: false, client, claimWaitMs: 20 });
    await settle(40);
    await act(async () => answer({ show: true, campaign: CAMPAIGN, url: URL_ }));
    await settle();
    expect(dialogs()).toBe(1);
    expect(log).toEqual(['claim', `shown:${CAMPAIGN}:painted`]);
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

  test('not before the page is ready or while the host gates fail', async () => {
    const { log, client } = fakeClient(yes);
    const s = await mount('a', { ready: false, eligible: true, firstRunWindow: true, client });
    await s.rerender({ ready: true, eligible: false, firstRunWindow: true, client });
    await settle();
    expect(log).toEqual([]);
    expect(dialogs()).toBe(0);
    expect(s.probe().dataset.holds).toBe('false');
  });

  test('in the VS Code panel too (the owner, 2026-11-25): claimed, drawn, stamped', async () => {
    (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE = true;
    const { log, client } = fakeClient(yes);
    await mount('a', { ready: true, eligible: true, firstRunWindow: true, client });
    await settle();
    expect(dialogs()).toBe(1);
    expect(log).toEqual(['claim', `shown:${CAMPAIGN}:painted`]);
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
    expect(log).toEqual(['claim', `shown:${CAMPAIGN}:painted`]);
  });
});
