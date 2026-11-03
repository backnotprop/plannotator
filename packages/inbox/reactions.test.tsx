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
const { ReactionBadge, ReactionLandedContext } = (hasDom ? await import('./components/ReactionBadge') : {}) as typeof import('./components/ReactionBadge');

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

function badge(id: string, at: string, onLanded: () => void): HTMLElement {
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

describe.if(hasDom)('the badge on the person\'s message', () => {
  test('a stored reaction (a reload, another device later): shown still, named, and silent', () => {
    let landed = 0;
    const host = badge('m-stored', new Date(Date.now() - 60_000).toISOString(), () => landed++);
    const rx = host.querySelector('.ib-rx') as HTMLElement;
    expect(rx).not.toBeNull();
    expect(rx.getAttribute('data-phase')).toBe('landed');
    expect(rx.getAttribute('role')).toBe('img');
    expect(rx.getAttribute('aria-label')).toBe('Claude Code reacted with ❤️');
    expect(rx.querySelector('.ib-rx-e')?.textContent).toBe('❤️');
    expect(landed).toBe(0);
  });

  test('landing while the thread is on screen: the sound once, as it lands; drawn again later, never again', async () => {
    let landed = 0;
    const at = new Date(Date.now() + 700).toISOString();
    const host = badge('m-live', at, () => landed++);
    // Before it lands: nothing yet, or the waiting shell; no sound.
    expect(host.querySelector('.ib-rx')?.getAttribute('data-phase') ?? 'hidden').not.toBe('landed');
    expect(landed).toBe(0);
    await act(async () => {
      await Bun.sleep(900);
    });
    expect(host.querySelector('.ib-rx')?.getAttribute('data-phase')).toBe('landed');
    expect(landed).toBe(1);
    // The thread closed and opened again (or re-rendered): still, silent.
    act(() => root?.unmount());
    document.body.innerHTML = '';
    const again = badge('m-live', at, () => landed++);
    expect(again.querySelector('.ib-rx')?.getAttribute('data-phase')).toBe('landed');
    expect(landed).toBe(1);
  });
});
