/**
 * The launch dialog in the Inbox (launchDialog.tsx), and once per computer across two surfaces, in the DOM.
 *
 * What regresses: the Inbox claiming while its settings say nothing is due, or never claiming again on a page left open
 * until launch day; the dialog on both plan review and the Inbox of one computer (one launch switch behind both
 * routes); a surface showing it again after it was answered; the Inbox's other reveals not holding back once it drew;
 * a phone or remote gate on the web Inbox (the owner left out only the native phone app: the phone-width page shows it);
 * the launch claimed while the welcome to the code review Inbox is open, or never in a tab that showed the welcome (it
 * waits for the line's gap after it, then shows); a claim answered after the page stopped being ready opening anyway.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLaunchSwitch, launchSwitchAction, LAUNCH_SWITCH_FILE, type LaunchShownRecord } from '../shared/launch-switch';

const hasDom = typeof document !== 'undefined';
const { InboxLaunchDialog } = (hasDom ? await import('./launchDialog') : {}) as typeof import('./launchDialog');
const { useLaunchAnnouncement } = (hasDom ? await import('@plannotator/ui/components/LaunchAnnouncement') : {}) as typeof import('@plannotator/ui/components/LaunchAnnouncement');
const { oneTimeDialogShownThisLoad, resetOneTimeDialogShownForTests, REVEAL_TIMES } = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { useLaunchAfterWelcome } = (hasDom ? await import('./reviewOnly') : {}) as typeof import('./reviewOnly');
type RevealStage = import('./reveal').RevealStage;
type LaunchClient = import('@plannotator/ui/components/LaunchAnnouncement').LaunchClient;

const CAMPAIGN = 'product-hunt-2026';
const URL_ = 'https://www.producthunt.com/posts/plannotator';
const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  if (hasDom) document.body.replaceChildren();
  resetOneTimeDialogShownForTests?.();
});

async function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return (next: React.ReactNode) => act(async () => root.render(next));
}

const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const dialogs = () => document.querySelectorAll('[data-launch-dialog]').length;

/** One computer: a kept "on" copy and one shown store, which every surface's routes share. */
function oneComputer(on = true) {
  const dir = mkdtempSync(join(tmpdir(), 'launch-dialog-'));
  const now = Date.now();
  const write = (isOn: boolean) =>
    writeFileSync(
      join(dir, LAUNCH_SWITCH_FILE),
      JSON.stringify({
        checkedAt: new Date(now).toISOString(),
        doc: isOn
          ? { v: 1, campaign: CAMPAIGN, on: true, url: URL_, startsAt: new Date(now - 3600_000).toISOString(), endsAt: new Date(now + 3600_000).toISOString() }
          : { v: 1, campaign: CAMPAIGN, on: false },
      }),
    );
  write(on);
  const records = new Map<string, LaunchShownRecord>();
  const claims: string[] = [];
  const service = createLaunchSwitch({
    dataDir: () => dir,
    endpoint: () => 'http://127.0.0.1:9/launch.json',
    shown: {
      read: (c) => records.get(c),
      write: (c, r) => (records.set(c, r), true),
      stamp: (c, r) => (records.get(c)?.shownAt ? 'taken' : (records.set(c, r), 'stamped')),
    },
    fetch: (async () => {
      throw new Error('no network in tests');
    }) as unknown as typeof fetch,
  });
  const surface = (name: string): LaunchClient => ({
    claim: async () => {
      claims.push(name);
      return launchSwitchAction(service, 'claim', {}).body as never;
    },
    shown: async (campaign) => launchSwitchAction(service, 'shown', { campaign }).body as { show: boolean },
    answer: async (answer, campaign) => launchSwitchAction(service, 'answer', { answer, campaign }).body,
  });
  return { records, claims, surface, turnOn: () => write(true) };
}

const artIn = async () => true;

function PlanReview({ client }: { client: LaunchClient }) {
  return <>{useLaunchAnnouncement({ ready: true, eligible: true, firstRunWindow: true, client, loadArt: artIn }).dialog}</>;
}

describe.skipIf(!hasDom)('the launch dialog across surfaces', () => {
  test('plan review and the Inbox open together: one draws; See the launch records opened; neither shows it again', async () => {
    const computer = oneComputer();
    await mount(<PlanReview client={computer.surface('plan')} />);
    await mount(<InboxLaunchDialog due ready heldBack={() => false} client={computer.surface('inbox')} />);
    await settle();
    expect(dialogs()).toBe(1);
    const link = document.querySelector<HTMLAnchorElement>('[data-launch-open]')!;
    link.addEventListener('click', (e) => e.preventDefault(), { once: true });
    await act(async () => link.click());
    await settle();
    expect(computer.records.get(CAMPAIGN)?.answer).toBe('opened');
    expect(dialogs()).toBe(0);
    await mount(<PlanReview client={computer.surface('plan-2')} />);
    await mount(<InboxLaunchDialog due ready heldBack={() => false} client={computer.surface('inbox-2')} />);
    await settle();
    expect(dialogs()).toBe(0);
  });

  test('the Inbox: no claim until its settings say due; a page left open claims on launch day; the reveals then hold back', async () => {
    const computer = oneComputer(false);
    const client = computer.surface('inbox');
    const rerender = await mount(<InboxLaunchDialog due={false} ready heldBack={() => false} client={client} loadArt={artIn} />);
    await settle();
    expect(computer.claims).toEqual([]);
    // Due, but the kept copy is still off on this read: nothing draws.
    await rerender(<InboxLaunchDialog due ready heldBack={() => false} client={client} loadArt={artIn} />);
    await settle();
    expect([computer.claims.length, dialogs()]).toEqual([1, 0]);
    // The switch turns on while the page stays open; the settings say due again.
    computer.turnOn();
    await rerender(<InboxLaunchDialog due={false} ready heldBack={() => false} client={client} loadArt={artIn} />);
    await rerender(<InboxLaunchDialog due ready heldBack={() => false} client={client} loadArt={artIn} />);
    await settle();
    expect([computer.claims.length, dialogs()]).toEqual([2, 1]);
    expect(oneTimeDialogShownThisLoad()).toBe(true);
    await act(async () => document.querySelector<HTMLElement>('[data-launch-not-now]')!.click());
    await settle();
    expect(computer.records.get(CAMPAIGN)?.answer).toBe('dismissed');
  });

  /** App's gate for the launch beside the welcome (`reviewWelcome.launchMay`), the other gates open. */
  function AfterWelcome({ stage, client }: { stage: RevealStage; client: LaunchClient }) {
    return <InboxLaunchDialog due ready={useLaunchAfterWelcome(stage)} heldBack={() => false} client={client} loadArt={artIn} />;
  }

  test('beside the welcome to the code review Inbox: no claim while it is claimed or open; once closed, the same tab shows the launch after the gap', async () => {
    const gap = REVEAL_TIMES.otherDialogMs;
    REVEAL_TIMES.otherDialogMs = 150;
    try {
      const computer = oneComputer();
      const client = computer.surface('inbox');
      const rerender = await mount(<AfterWelcome stage="claimed" client={client} />);
      await rerender(<AfterWelcome stage="open" client={client} />);
      await settle(60);
      expect(computer.claims).toEqual([]);
      await rerender(<AfterWelcome stage="shown" client={client} />);
      await settle(60);
      expect([computer.claims.length, dialogs()]).toEqual([0, 0]);
      await settle(200);
      expect([computer.claims.length, dialogs()]).toEqual([1, 1]);
    } finally {
      REVEAL_TIMES.otherDialogMs = gap;
    }
  });

  test('a load where the welcome never came claims at once', async () => {
    const computer = oneComputer();
    await mount(<AfterWelcome stage="none" client={computer.surface('inbox')} />);
    await settle();
    expect([computer.claims.length, dialogs()]).toEqual([1, 1]);
  });

  test('a claim answered yes while the page stopped being ready (another dialog drew meanwhile) does not open until it is ready again', async () => {
    const computer = oneComputer();
    const client = computer.surface('inbox');
    let artLoaded = () => {};
    const art = () => new Promise<boolean>((resolve) => (artLoaded = () => resolve(true)));
    const rerender = await mount(<InboxLaunchDialog due ready heldBack={() => false} client={client} loadArt={art} />);
    await settle();
    expect(computer.claims.length).toBe(1);
    await rerender(<InboxLaunchDialog due ready={false} heldBack={() => false} client={client} loadArt={art} />);
    await act(async () => artLoaded());
    await settle();
    expect(dialogs()).toBe(0);
    await rerender(<InboxLaunchDialog due ready heldBack={() => false} client={client} loadArt={art} />);
    await settle();
    expect(dialogs()).toBe(1);
  });

  test('the web Inbox at phone width shows it too (only the native phone app leaves it out)', async () => {
    const width = window.innerWidth;
    const media = window.matchMedia;
    (window as { innerWidth: number }).innerWidth = 390;
    window.matchMedia = ((query: string) => ({ matches: /max-width|pointer:\s*coarse|hover:\s*none/.test(query), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
    try {
      const computer = oneComputer();
      await mount(<InboxLaunchDialog due ready heldBack={() => false} client={computer.surface('phone-width inbox')} loadArt={artIn} />);
      await settle(300);
      expect(dialogs()).toBe(1);
      expect(computer.records.get(CAMPAIGN)?.shownAt).toBeString();
    } finally {
      (window as { innerWidth: number }).innerWidth = width;
      window.matchMedia = media;
    }
  });
});
