import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { LiveSession, LiveSessionsModel } from './api';

const hasDom = typeof document !== 'undefined';
const { NewMessagePopover } = (hasDom ? await import('./components/NewMessage') : {}) as typeof import('./components/NewMessage');

const session = (id: string, host: string, minute: number): LiveSession =>
  ({
    session: id,
    host,
    started_at: `2026-10-21T15:${String(minute).padStart(2, '0')}:00.000Z`,
    last_seen_at: '2026-10-21T16:00:00.000Z',
    idle_since: null,
    busy: false,
    wrote_thread: false,
  }) as unknown as LiveSession;

const LIVE = {
  sessions: [session('ses_1', 'claude-code', 1), session('ses_2', 'pi', 2), session('ses_3', 'opencode', 3), session('ses_4', 'pi', 4)],
  home: '/home/me',
} as unknown as LiveSessionsModel;

const THREAD = { thread_id: 'thr_1', project: { name: 'ledger', root: '/home/me/ledger' } } as unknown as InboxThread;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(onClose: () => void, windowEscapes: { count: number }) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  const onWindowKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') windowEscapes.count += 1;
  };
  window.addEventListener('keydown', onWindowKey);
  root = createRoot(host);
  const render = (open: boolean) =>
    act(() =>
      root!.render(
        <section>
          <button type="button" data-new-message="">
            New message
          </button>
          <NewMessagePopover
            thread={THREAD}
            asker="Claude Code"
            askerHost="claude-code"
            live={LIVE}
            mode={open ? { kind: 'pick' } : null}
            onPick={() => {}}
            onReplyInstead={() => {}}
            onClose={() => {
              onClose();
              render(false);
            }}
          />
        </section>,
      ),
    );
  render(true);
  return () => window.removeEventListener('keydown', onWindowKey);
}

const items = () => [...host!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const press = (key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
};

test.skipIf(!hasDom)('the session picker moves focus like a menu: into it on open, arrows wrap, Home / End, type-ahead, one Tab stop', () => {
  const unlisten = mount(() => {}, { count: 0 });
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  const pause = () => {
    offset += 1000;
  };
  try {
    expect(host!.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement).toBe(items()[0]);
    expect(items().map((el) => el.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(press('ArrowDown').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items()[1]);
    expect(items().map((el) => el.tabIndex)).toEqual([-1, 0, -1, -1]);
    press('ArrowUp');
    press('ArrowUp');
    expect(document.activeElement).toBe(items()[3]);
    press('ArrowDown');
    expect(document.activeElement).toBe(items()[0]);
    press('End');
    expect(document.activeElement).toBe(items()[3]);
    press('Home');
    expect(document.activeElement).toBe(items()[0]);
    press('o');
    expect(document.activeElement).toBe(items()[2]);
    pause();
    press('p');
    expect(document.activeElement).toBe(items()[3]);
    press('p');
    expect(document.activeElement).toBe(items()[1]);
    expect(host!.querySelectorAll('.ib-mi.ib-on')).toHaveLength(1);
    expect(items()[1]!.classList.contains('ib-on')).toBe(true);
  } finally {
    Date.now = realNow;
    unlisten();
  }
});

test.skipIf(!hasDom)('Escape in the session picker closes it, puts focus back on New message, and goes no further', () => {
  let closed = 0;
  const windowEscapes = { count: 0 };
  const unlisten = mount(() => (closed += 1), windowEscapes);
  try {
    press('ArrowDown');
    const event = press('Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(closed).toBe(1);
    expect(host!.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(host!.querySelector('[data-new-message]'));
    expect(windowEscapes.count).toBe(0);
  } finally {
    unlisten();
  }
});
