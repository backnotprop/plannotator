/**
 * The personal agents dialog in a DOM (components/PersonalAgentsIntro.tsx), driven by the line's hook as App wires it.
 *
 * What regresses: the second button not opening Settings → Agents, or sending a Not now; Got it sending a Not now (it
 * settles the dialog: no three-day wait); Escape not being the Not now; the idle clock not running while it is next
 * (its idle moment never coming); the banner drawn after a failed or slow load (a broken picture or a jump), or
 * missing after both loaded; the banner's words missing from its alt text and from the dialog's own text.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { PERSONAL_AGENTS_BANNER_WORDS } from '@plannotator/core/inbox-personal-agents';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const intro = (hasDom ? await import('./components/PersonalAgentsIntro') : {}) as typeof import('./components/PersonalAgentsIntro');
const route = (hasDom ? await import('./settingsRoute') : {}) as typeof import('./settingsRoute');

const TIMES = { pageAgeMs: 300, readMs: 60, settledMs: 60, momentMs: 1500, recheckMs: 20, claimRetryMs: 30, broReadMs: 120 };

let root: Root | null = null;
let savedTimes: typeof reveal.REVEAL_TIMES;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: { path: string; body: Record<string, unknown> }[] = [];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  savedFetch = globalThis.fetch;
  posts = [];
  window.location.hash = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (path.endsWith('/api/inbox/reveal')) return json({ show: true, reveal: { next: null } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
  window.location.hash = '';
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="personal-agents-intro"]');
const notNows = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal') && p.body.answer === 'not_now');

const ROW = { thread_id: 'msg_a', section: 'sent', unseen: 0 } as InboxListRow;

function Harness({ banner }: { banner: boolean }) {
  const r = reveal.useLineReveal({
    id: 'personal_agents',
    due: true,
    blocked: false,
    rows: [ROW],
    toast: false,
    thread: null,
    clear: true,
    place: '',
    heldBack: () => false,
    leaveCounts: () => true,
    atOnce: true,
    mayClaim: () => true,
    holds: () => true,
  });
  return r.stage === 'open' ? <intro.PersonalAgentsIntro phone={false} banner={banner} close={r.close} /> : null;
}

async function open(banner = true) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness banner={banner} />);
  });
  await until(() => dialog() !== null, 5_000);
  expect(dialog()).not.toBeNull();
}

describe.skipIf(!hasDom)('the personal agents dialog', () => {
  test('the second button closes it and opens Settings → Agents, with no Not now', async () => {
    await open();
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-personal-agents-settings]')!.click());
    await until(() => dialog() === null);
    expect(dialog()).toBeNull();
    expect(route.parseSettingsHash(window.location.hash.slice(1))?.section).toBe('agents');
    expect(notNows()).toHaveLength(0);
  });

  test('Got it settles it: closed, no Not now, the page stays where it was', async () => {
    await open();
    act(() => dialog()!.querySelector<HTMLButtonElement>('[data-personal-agents-done]')!.click());
    await until(() => dialog() === null);
    expect(dialog()).toBeNull();
    expect(notNows()).toHaveLength(0);
    expect(window.location.hash).toBe('');
  });

  test('Escape is its Not now', async () => {
    await open();
    act(() => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await until(() => dialog() === null);
    expect(dialog()).toBeNull();
    await until(() => notNows().length > 0);
    expect(notNows().map((p) => p.body.id)).toEqual(['personal_agents']);
  });

  test('with its banner: light and dark pictures with the baked words as alt text, and the same words as its title', async () => {
    await open(true);
    const imgs = [...dialog()!.querySelectorAll<HTMLImageElement>('[data-personal-agents-banner] img')];
    expect(imgs).toHaveLength(2);
    for (const img of imgs) expect(img.alt).toBe(PERSONAL_AGENTS_BANNER_WORDS);
    expect(`${dialog()!.querySelector('h2')!.textContent}.`).toBe(PERSONAL_AGENTS_BANNER_WORDS);
  });

  test('without its banner (it did not load): no picture at all, the words and both buttons still there', async () => {
    await open(false);
    expect(dialog()!.querySelector('[data-personal-agents-banner], img')).toBeNull();
    expect(dialog()!.querySelector('h2')!.textContent).toBe(intro.PERSONAL_AGENTS_COPY.title);
    expect(dialog()!.querySelectorAll('button')).toHaveLength(2);
  });
});

describe.skipIf(!hasDom)('its moment', () => {
  test('the page going idle is one: the idle clock runs while it is next', () => {
    expect(reveal.idleClockArmed({ next: 'personal_agents', ahead: [] }, false)).toBe(true);
  });
});

describe.skipIf(!hasDom)('the banner probe', () => {
  test('drawn only when both pictures load; one failing or both slow: none', async () => {
    expect(await intro.probePersonalAgentsBanner(async () => {})).toBe(true);
    expect(await intro.probePersonalAgentsBanner(async (srcset) => (srcset.includes('dark') ? Promise.reject(new Error('offline')) : undefined))).toBe(false);
    expect(await intro.probePersonalAgentsBanner(() => new Promise(() => {}), 30)).toBe(false);
  });

  test('asks for both widths of each picture', async () => {
    const asked: string[] = [];
    await intro.probePersonalAgentsBanner(async (srcset) => void asked.push(srcset));
    expect(asked).toHaveLength(2);
    for (const srcset of asked) expect(srcset).toMatch(/^https:\/\/plannotator\.ai\/assets\/hosted\/personal-agents-b-(light|dark)\.webp 1x, \S+@2x\.webp 2x$/);
  });
});
