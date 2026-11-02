/**
 * The opened card's Links rows for YouTrack issues and any other web link
 * (user feedback #10), as the window draws them. What regresses: a YouTrack
 * issue drawn without its mark and key, a web link drawn without its short
 * label or opening in this tab, a favicon asked for a link an agent added, a
 * remote favicon address (the window's CSP blocks it), or a failed, blank or
 * still-loading favicon showing a broken image instead of the link icon.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxCardRef, InboxCardWire } from '@plannotator/core/inbox-types';
import type { CardPanelProps } from './board/CardPanel';

const hasDom = typeof document !== 'undefined';
const { CardPanel, LinkFavicon } = (hasDom ? await import('./board/CardPanel') : {}) as typeof import('./board/CardPanel');
// The window's own origin, so the favicon route's relative address parses (happy-dom loads no image from it).
if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');

const CLAUDE: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_claude', name: 'Claude Code' };
const AT = '2026-11-02T09:00:00.000Z';

const YOUTRACK: InboxCardRef = { kind: 'issue', source: 'youtrack', ref: 'PROJ-123', url: 'https://acme.youtrack.cloud/issue/PROJ-123', via: 'ref' };
const MINE: InboxCardRef = { kind: 'link', source: 'web', ref: 'notion.so/acme/Roadmap-2026', url: 'https://www.notion.so/acme/Roadmap-2026', via: 'ref', by: 'person' };
const AGENTS: InboxCardRef = { kind: 'link', source: 'web', ref: 'linear.app/acme/issue/ENG-12', url: 'https://linear.app/acme/issue/ENG-12', via: 'ref' };
const LOCAL: InboxCardRef = { kind: 'link', source: 'web', ref: 'localhost:3000/app', url: 'http://localhost:3000/app', via: 'ref', by: 'person' };
const LONG: InboxCardRef = {
  kind: 'link',
  source: 'web',
  ref: 'x',
  url: `https://www.figma.com/design/AbCdEf123/${'Onboarding-flow-'.repeat(6)}v2?node-id=1-2`,
  via: 'ref',
  by: 'person',
};

const card = {
  id: 'crd_1',
  project_id: 'prj_1',
  title: 'Tickets',
  column: 'in_progress',
  you: null,
  said: null,
  threads: [],
  prs: [],
  refs: [YOUTRACK, MINE, AGENTS, LOCAL, LONG],
  agent: CLAUDE,
  created_at: AT,
  created_by: CLAUDE,
  moved_at: AT,
  heard_at: AT,
  heard_by: CLAUDE,
  dropped: null,
  aside_from: null,
  idempotency_key: null,
  notes: null,
  sent: null,
} as unknown as InboxCardWire;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(element: React.ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}

const noop = () => {};
function panel(): HTMLElement {
  const props: CardPanelProps = {
    card,
    history: [],
    refs: card.refs!.map((ref) => ({ ref, result: { ok: false, error: 'unsupported', fetchedAt: 0 } })),
    projectName: 'app',
    repo: null,
    state: null,
    canAsk: false,
    rowOf: () => null,
    phone: false,
    now: Date.parse(AT),
    onClose: noop,
    onColumn: noop,
    onShip: noop,
    onRestore: noop,
    onDrop: noop,
    onSend: noop,
    onStart: async () => null,
    onAsk: async () => null,
    onNotes: async () => true,
    onLink: async () => null,
    onOpenThread: noop,
    onCreateThread: noop,
  } as CardPanelProps;
  return mount(createElement(CardPanel, props));
}

const row = (host: HTMLElement, url: string) => {
  const link = [...host.querySelectorAll<HTMLAnchorElement>('.ib-crdp-ref a')].find((a) => a.getAttribute('href') === url);
  return { link: link!, row: link!.closest('li')! };
};

describe('opened card links: YouTrack and any web link (user feedback #10)', () => {
  test.if(hasDom)("a YouTrack issue: its key links the issue in a new tab, beside YouTrack's mark and its site", () => {
    const { link, row: li } = row(panel(), YOUTRACK.url);
    expect(link.textContent).toBe('PROJ-123');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('aria-label')).toBe('YouTrack issue PROJ-123');
    const mark = li.querySelector('svg[data-ref-mark="youtrack"]');
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute('aria-hidden')).toBe('true');
    expect(mark!.querySelector('path')!.getAttribute('fill')).toBe('currentColor');
    expect(li.querySelector('[data-icon="link"]')).toBeNull();
    expect(li.querySelector('.ib-crdp-rref')!.textContent).toBe('acme.youtrack.cloud');
  });

  test.if(hasDom)('a web link: its short label (host and path) links the full URL in a new tab, with no state', () => {
    const host = panel();
    const { link, row: li } = row(host, MINE.url);
    expect(link.textContent).toBe('notion.so/acme/Roadmap-2026');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(li.getAttribute('data-ref-source')).toBe('web');
    expect(li.querySelector('[data-ref-kind]')).toBeNull();
    // A long URL: cut in the middle, the full URL still the link.
    const long = row(host, LONG.url).link;
    expect(long.textContent!.length).toBeLessThanOrEqual(44);
    expect(long.textContent).toStartWith('figma.com/design/');
    expect(long.textContent).toEndWith('flow-v2');
    expect(long.textContent).toContain('…');
  });

  test.if(hasDom)("the favicon: asked from the Inbox's own route for the person's https link only; an agent's or a local link shows the link icon and asks nothing", () => {
    const host = panel();
    const img = (url: string) => row(host, url).row.querySelector('img');
    const mine = img(MINE.url);
    expect(mine).not.toBeNull();
    expect(mine!.getAttribute('src')).toBe(`/api/inbox/cards/crd_1/favicon?url=${encodeURIComponent(MINE.url)}`);
    expect(mine!.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(mine!.getAttribute('loading')).toBe('lazy');
    // While it loads, the link icon is what shows.
    expect(row(host, MINE.url).row.querySelector('[data-icon="link"]')).not.toBeNull();
    for (const url of [AGENTS.url, LOCAL.url]) {
      expect(img(url)).toBeNull();
      expect(row(host, url).row.querySelector('[data-icon="link"]')).not.toBeNull();
    }
    // Never a remote address: the window's CSP would block it.
    for (const each of host.querySelectorAll('img')) expect(each.getAttribute('src')).toStartWith('/api/inbox/');
  });
});

describe('LinkFavicon', () => {
  const load = (img: HTMLImageElement, width: number, height: number) => {
    Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
    act(() => {
      img.dispatchEvent(new Event('load'));
    });
  };

  test.if(hasDom)('a favicon that fails to load falls back to the link icon, and is not asked again', () => {
    const src = '/api/inbox/cards/crd_1/favicon?url=https%3A%2F%2Fbroken.example%2F';
    const host = mount(createElement(LinkFavicon, { src }));
    const box = host.querySelector('[data-ref-mark="web"]')!;
    expect(box.querySelector('[data-icon="link"]')).not.toBeNull();
    act(() => {
      box.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('[data-icon="link"]')).not.toBeNull();
    act(() => root!.unmount());
    // Drawn again (the card reopened), the same address is not asked a second time.
    const again = mount(createElement(LinkFavicon, { src }));
    expect(again.querySelector('img')).toBeNull();
    expect(again.querySelector('[data-icon="link"]')).not.toBeNull();
  });

  test.if(hasDom)('a blank 1×1 favicon falls back too; a real one replaces the link icon in the same box', () => {
    const blank = mount(createElement(LinkFavicon, { src: '/api/inbox/cards/crd_1/favicon?url=blank' }));
    load(blank.querySelector('img')!, 1, 1);
    expect(blank.querySelector('img')).toBeNull();
    expect(blank.querySelector('[data-icon="link"]')).not.toBeNull();
    act(() => root!.unmount());

    const real = mount(createElement(LinkFavicon, { src: '/api/inbox/cards/crd_1/favicon?url=real' }));
    const img = real.querySelector('img')!;
    expect(img.hasAttribute('data-shown')).toBe(false);
    load(img, 16, 16);
    expect(real.querySelector('img')!.hasAttribute('data-shown')).toBe(true);
    expect(real.querySelector('[data-icon="link"]')).toBeNull();
    expect(real.querySelector('[data-ref-mark="web"]')!.getAttribute('data-favicon')).toBe('shown');
  });
});
