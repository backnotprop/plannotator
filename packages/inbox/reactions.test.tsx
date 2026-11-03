/**
 * Emoji reactions in the window (approval "inbox-emoji-reactions"): the card
 * last on Settings → Capabilities (Off / Now and then / Often, and its Sound
 * row, greyed and inert while Off), and the badge on the person's message: a
 * stored reaction shows still and silent on a page that opens the thread
 * later (a reload, another device), and a reaction landing while the thread
 * is on screen plays its sound once, as it lands, never again for the same
 * reaction.
 *
 * What regresses: a card that is not last or that leaves the Sound row live
 * while Off; a reload replaying the arrival or its sound; a sound on every
 * render.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * The decision itself is packages/shared/inbox/reactions/reactions.test.ts;
 * the setting's sync and the stored reaction are packages/server/inbox-reactions.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxReactionsSettings } from '@plannotator/core/inbox-types';
import type { SettingsModel } from './api';
import type { InboxSound } from './sound';

const hasDom = typeof document !== 'undefined';
const { SettingsPage } = (hasDom ? await import('./components/Settings') : {}) as typeof import('./components/Settings');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { ReactionBadge, ReactionLandedContext, reactionSoundOn } = (hasDom ? await import('./components/ReactionBadge') : {}) as typeof import('./components/ReactionBadge');
const { useInboxSound } = (hasDom ? await import('./sound') : {}) as typeof import('./sound');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const settingsModel = (reactions: InboxReactionsSettings) =>
  ({
    serverSession: 's',
    version: '0.29.0',
    port: 1,
    url: 'http://localhost:1/',
    mcp_url: 'http://127.0.0.1:1/mcp',
    mcp_command: ['plannotator', 'inbox', 'mcp'],
    home: '/home/u',
    data_dir: '/home/u/.plannotator',
    inbox_tool: { hosts: { 'claude-code': true, pi: false, opencode: false }, env: null },
    notifications: { enabled: true, dismissed: false, allowed_origin: null },
    sound: { enabled: true, volume: 60, dialog_shown_for: null },
    board: { on: true },
    experimental: { decision_mode: { on: false, env: null } },
    reactions,
    phones: false,
    store_dir: '/home/u/.plannotator/inbox',
  }) as unknown as SettingsModel;

function fakeSound(): { sound: InboxSound; seen: string[] } {
  const seen: string[] = [];
  const sound = {
    settings: { enabled: true, volume: 60, dialog_shown_for: null },
    armed: true,
    playing: false,
    preview: () => {},
    questionsArrived: () => {},
    otherTabInFront: () => false,
    reactionLanded: () => void seen.push('landed'),
    previewReaction: () => void seen.push('preview'),
    reactionPlaying: false,
    setEnabled: async () => true,
    setVolume: async () => true,
  } as InboxSound;
  return { sound, seen };
}

function capabilities(reactions: InboxReactionsSettings, onReactions: (change: Partial<InboxReactionsSettings>) => void, sound: InboxSound): HTMLElement {
  const noop = () => {};
  return mount(
    <SidebarProvider>
      <SettingsPage
        settings={settingsModel(reactions)}
        context={null}
        error={null}
        section="capabilities"
        onToggleTool={noop}
        onToggleTailscale={noop}
        tailscaleBusy={false}
        permission="granted"
        onToggleNotifications={noop}
        onDeleteThread={async () => {}}
        onDeleteProject={async () => {}}
        onToggleBoard={noop}
        onToggleExperimental={noop}
        onReactions={onReactions}
        sound={sound}
      />
    </SidebarProvider>,
  );
}

describe.if(hasDom)('Settings → Capabilities: Emoji reactions', () => {
  test('the last card on the page: Off / Now and then / Often, then Sound; a choice saves only the level', () => {
    const changes: Partial<InboxReactionsSettings>[] = [];
    const { sound, seen } = fakeSound();
    const host = capabilities({ level: 'sometimes', sound: true }, (c) => changes.push(c), sound);
    const groups = [...host.querySelectorAll('.ib-spg .ib-sgroup')];
    const card = host.querySelector('[data-settings-reactions]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(groups[groups.length - 1]).toBe(card);
    const radios = [...card.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.parentElement!.textContent)).toEqual(['Off', 'Now and then', 'Often']);
    expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
    act(() => radios[2]!.click());
    expect(changes).toEqual([{ level: 'often' }]);
    // The Sound row is live: its preview plays and its switch saves.
    const row = card.querySelector('[data-settings-reactions-sound]') as HTMLElement;
    expect(row.hasAttribute('data-off')).toBe(false);
    act(() => (row.querySelector('[data-reactions-play]') as HTMLButtonElement).click());
    expect(seen).toEqual(['preview']);
    act(() => (row.querySelector('[role="switch"]') as HTMLButtonElement).click());
    expect(changes[changes.length - 1]).toEqual({ sound: false });
  });

  test('Off: the Sound row greys out and does nothing', () => {
    const changes: Partial<InboxReactionsSettings>[] = [];
    const { sound, seen } = fakeSound();
    const host = capabilities({ level: 'off', sound: true }, (c) => changes.push(c), sound);
    const row = host.querySelector('[data-settings-reactions-sound]') as HTMLElement;
    expect(row.hasAttribute('data-off')).toBe(true);
    const play = row.querySelector('[data-reactions-play]') as HTMLButtonElement;
    const sw = row.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    expect(sw.disabled).toBe(true);
    act(() => {
      play.click();
      sw.click();
    });
    expect(seen).toEqual([]);
    expect(changes).toEqual([]);
  });
});


function badge(id: string, at: string, onLanded: (key: string) => void): HTMLElement {
  return mount(
    <ReactionLandedContext.Provider value={onLanded}>
      <article className="ib-message">
        <div className="ib-msg">
          <div className="ib-body">
            <p>Perfect, that's exactly what I wanted.</p>
          </div>
          <ReactionBadge messageId={id} reaction={{ emoji: '❤️', at }} agent="Claude Code" phone={false} />
        </div>
      </article>
    </ReactionLandedContext.Provider>,
  );
}

const phase = (host: HTMLElement) => host.querySelector('.ib-rx')?.getAttribute('data-phase') ?? 'hidden';

/** Run `fn` with the page's visibility and reduced-motion preference as given, restored after. */
async function withPage(page: { hidden?: boolean; reduce?: boolean }, fn: (set: (hidden: boolean) => void) => Promise<void> | void) {
  let hidden = page.hidden ?? false;
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const matchMedia = window.matchMedia;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  if (page.reduce) {
    window.matchMedia = ((query: string) =>
      ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }
  try {
    await fn((next) => (hidden = next));
  } finally {
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else delete (document as unknown as Record<string, unknown>).visibilityState;
    window.matchMedia = matchMedia;
  }
}

const wait = (ms: number) =>
  act(async () => {
    await Bun.sleep(ms);
  });

describe.if(hasDom)("the badge on the person's message", () => {
  test('a stored reaction (a reload, another device later): shown still, named, and silent', () => {
    const landed: string[] = [];
    const host = badge('m-stored', new Date(Date.now() - 60_000).toISOString(), (key) => landed.push(key));
    const rx = host.querySelector('.ib-rx') as HTMLElement;
    expect(rx).not.toBeNull();
    expect(rx.getAttribute('data-phase')).toBe('landed');
    expect(rx.getAttribute('role')).toBe('img');
    expect(rx.getAttribute('aria-label')).toBe('Claude Code reacted with ❤️');
    expect(rx.querySelector('.ib-rx-e')?.textContent).toBe('❤️');
    expect(landed).toEqual([]);
  });

  test('landing while the thread is on screen: the sound once, as it lands, named for the reaction; drawn again later, never again', async () => {
    const landed: string[] = [];
    const at = new Date(Date.now() + 700).toISOString();
    const host = badge('m-live', at, (key) => landed.push(key));
    // Before it lands: nothing yet, or the waiting shell; no sound.
    expect(phase(host)).not.toBe('landed');
    expect(landed).toEqual([]);
    await wait(900);
    expect(phase(host)).toBe('landed');
    expect(landed).toEqual([`m-live:${at}`]);
    // The thread closed and opened again (or re-rendered): still, silent.
    act(() => root?.unmount());
    document.body.innerHTML = '';
    const again = badge('m-live', at, (key) => landed.push(key));
    expect(phase(again)).toBe('landed');
    expect(landed).toHaveLength(1);
  });

  test('a page that is not in view: silent, whether it was hidden all along or went away before it landed', async () => {
    await withPage({ hidden: true }, async () => {
      const landed: string[] = [];
      const host = badge('m-hidden', new Date(Date.now() + 300).toISOString(), (key) => landed.push(key));
      await wait(500);
      expect(phase(host)).toBe('landed');
      expect(landed).toEqual([]);
    });
    act(() => root?.unmount());
    document.body.innerHTML = '';
    await withPage({}, async (setHidden) => {
      const landed: string[] = [];
      const host = badge('m-away', new Date(Date.now() + 700).toISOString(), (key) => landed.push(key));
      setHidden(true);
      await wait(900);
      expect(phase(host)).toBe('landed');
      expect(landed).toEqual([]);
    });
  });

  test('reduced motion: no waiting shell, the badge appears as it lands', async () => {
    await withPage({ reduce: true }, async () => {
      const host = badge('m-reduce', new Date(Date.now() + 800).toISOString(), () => {});
      const seen = new Set<string>([phase(host)]);
      for (let i = 0; i < 10; i++) {
        await wait(100);
        seen.add(phase(host));
      }
      expect(seen.has('shell')).toBe(false);
      expect(phase(host)).toBe('landed');
    });
  });

  test("a device whose clock is behind the computer's still shows it within the longest delay", async () => {
    // The reaction's time reads a minute ahead on this page's clock.
    const host = badge('m-skew', new Date(Date.now() + 60_000).toISOString(), () => {});
    await wait(2800);
    expect(phase(host)).toBe('landed');
  });
});

describe.if(hasDom)('the reaction sound', () => {
  test('plays only while reactions are on and their Sound switch is', () => {
    expect(reactionSoundOn({ level: 'sometimes', sound: true })).toBe(true);
    expect(reactionSoundOn({ level: 'often', sound: true })).toBe(true);
    expect(reactionSoundOn({ level: 'often', sound: false })).toBe(false);
    expect(reactionSoundOn({ level: 'off', sound: true })).toBe(false);
    expect(reactionSoundOn(undefined)).toBe(false);
  });

  test('two Inbox tabs showing the thread: the reaction plays once; the next reaction plays again', () => {
    let oscillators = 0;
    const param = () => ({ value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} });
    class StubContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume() {
        return Promise.resolve();
      }
      createGain() {
        return { gain: param(), connect: (to: unknown) => to };
      }
      createOscillator() {
        oscillators++;
        return { type: 'sine', frequency: param(), connect: (to: unknown) => to, start() {}, stop() {} };
      }
    }
    const ctx = (window as unknown as { AudioContext?: unknown }).AudioContext;
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    (window as unknown as { AudioContext: unknown }).AudioContext = StubContext;
    // No Web Locks: the localStorage claim, which every tab of this browser shares.
    Object.defineProperty(navigator, 'locks', { configurable: true, get: () => undefined });
    try {
      const tabs: InboxSound[] = [];
      function Tab({ n }: { n: number }) {
        tabs[n] = useInboxSound({ settings: { enabled: true, volume: 60, dialog_shown_for: null }, onSettings: () => {} });
        return null;
      }
      mount(
        <>
          <Tab n={0} />
          <Tab n={1} />
        </>,
      );
      act(() => {
        window.dispatchEvent(new Event('pointerdown'));
      });
      act(() => {
        tabs[0]!.reactionLanded('m1:t');
        tabs[1]!.reactionLanded('m1:t');
      });
      // "Deeper" is four oscillators: one play.
      expect(oscillators).toBe(4);
      act(() => {
        tabs[1]!.reactionLanded('m2:t');
        tabs[0]!.reactionLanded('m2:t');
      });
      expect(oscillators).toBe(8);
    } finally {
      (window as unknown as { AudioContext: unknown }).AudioContext = ctx;
      if (locks) Object.defineProperty(navigator, 'locks', locks);
      else delete (navigator as unknown as Record<string, unknown>).locks;
      try {
        window.localStorage.clear();
      } catch {}
    }
  });
});
