/**
 * The What's new page's header as drawn (approvals
 * .product/approved/inbox-whats-new-header/, variant Toolbar, and
 * inbox-whats-new-tldr, round 2): the bar's way back and its actions,
 * "Plannotator 0.28.22" on one line, the standing meta in its states
 * (current, behind, development build), Update only when the page's release
 * can be installed, and no "Also in the releases since X" box.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxUpdate } from '@plannotator/core/inbox-types';
import type { WhatsNewModel, WhatsNewReleasesModel } from './api';

const hasDom = typeof document !== 'undefined';
// Updates.tsx draws the notes with ui's Viewer, which reads `window` at module-eval time.
const { WhatsNewPage, whatsNewStanding, whatsNewCanUpdate } = (hasDom ? await import('./components/Updates') : {}) as typeof import('./components/Updates');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const model = (over: Partial<WhatsNewModel> = {}): WhatsNewModel => ({
  version: '0.28.22',
  current: '0.28.19',
  since: '0.28.19',
  published_at: '2026-10-15T12:00:00Z',
  release_url: 'https://github.com/backnotprop/plannotator/releases/tag/v0.28.22',
  notes: 'Mostly Inbox work.',
  skipped: [
    { version: '0.28.21', text: 'Twenty-one' },
    { version: '0.28.20', text: 'Twenty' },
  ],
  ...over,
});

const update = (state: InboxUpdate['state'], version = '0.28.22'): InboxUpdate => ({
  available: true,
  state,
  version,
  current: '0.28.19',
  action: 'script',
  releaseUrl: `https://github.com/backnotprop/plannotator/releases/tag/v${version}`,
});

function render(props: { model: WhatsNewModel | null; update?: InboxUpdate | null; onBack?: () => void; onUpdate?: () => void; releases?: WhatsNewReleasesModel | null }) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <WhatsNewPage
          model={props.model}
          error={null}
          update={props.update ?? null}
          releases={props.releases ?? null}
          onBack={props.onBack ?? (() => {})}
          onUpdate={props.onUpdate ?? (() => {})}
        />
      </SidebarProvider>,
    );
  });
  return host;
}

const chip = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-whats-new-standing]');

test.skipIf(!hasDom)('the standing: current, behind with the releases in between, a development build, past it', () => {
  expect(whatsNewStanding(model({ current: '0.28.22' }))).toEqual({ kind: 'current' });
  expect(whatsNewStanding(model())).toEqual({ kind: 'behind', current: '0.28.19', between: 2 });
  // The releases in between are counted from the panel's releases and the notes' own list, each once.
  expect(whatsNewStanding(model({ skipped: [] }), ['0.28.22', '0.28.21', '0.28.20', '0.28.19', '0.28.18'])).toEqual({ kind: 'behind', current: '0.28.19', between: 2 });
  expect(whatsNewStanding(model(), ['0.28.21'])).toEqual({ kind: 'behind', current: '0.28.19', between: 2 });
  // A development build is never "You have dev", whatever the release.
  expect(whatsNewStanding(model({ current: 'dev' }))).toEqual({ kind: 'dev' });
  expect(whatsNewStanding(model({ current: '0.0.0-dev' }))).toEqual({ kind: 'dev' });
  expect(whatsNewStanding(model({ current: '0.28.23' }))).toEqual({ kind: 'ahead', current: '0.28.23' });
});

test.skipIf(!hasDom)('on the version: one quiet line, no Update, no jump, and no "Also in the releases since" box', () => {
  const el = render({ model: model({ current: '0.28.22', since: '0.28.19' }), update: null });
  expect(chip(el)?.dataset.whatsNewStanding).toBe('current');
  expect(chip(el)?.tagName).toBe('SPAN');
  expect(chip(el)?.textContent).toBe("You're on this version");
  expect(el.querySelector('[data-whats-new-update]')).toBeNull();
  // The box is gone (approval inbox-whats-new-tldr): the panel tags your version instead.
  expect(el.querySelector('[data-skipped-releases]')).toBeNull();
  expect(el.textContent).not.toContain('Also in the releases since');
});

test.skipIf(!hasDom)('a development build says so and never names "dev" as a version', () => {
  const el = render({ model: model({ current: 'dev', since: null, skipped: [] }) });
  expect(chip(el)?.dataset.whatsNewStanding).toBe('dev');
  expect(el.querySelector('.ib-wn-hero')?.textContent).not.toContain('You have dev');
});

test.skipIf(!hasDom)('behind: the meta names the version and the releases in between, and takes the panel to your row', () => {
  const releases: WhatsNewReleasesModel = {
    latest: '0.28.22',
    current: '0.28.19',
    refreshing: false,
    offline: false,
    fetched_at: null,
    releases: ['0.28.22', '0.28.21', '0.28.20', '0.28.19'].map((version) => ({ version, published_at: null, tldr: [], listed: null, sentence: null, saved: true })),
  };
  // A window wide enough for the panel (under 1100 px the meta opens the sheet instead).
  const realMatch = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query.includes('min-width: 1100px'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const el = render({ model: model({ skipped: [] }), releases });
  const button = chip(el) as HTMLButtonElement;
  expect(button.tagName).toBe('BUTTON');
  expect(button.textContent).toBe('You have 0.28.19 · 2 releases in between');
  const mine = el.querySelector<HTMLElement>('[data-whats-new-panel] [data-whats-new-release="0.28.19"]')!;
  const list = el.querySelector<HTMLElement>('[data-whats-new-panel] .ib-wn-pscroll')!;
  // Only the panel's list scrolls to your row: scrollIntoView would also scroll the page (and its notes) under the sticky panel.
  let pageScrolled = false;
  mine.scrollIntoView = () => {
    pageScrolled = true;
  };
  const listScrolls: number[] = [];
  list.scrollTo = ((options: ScrollToOptions) => listScrolls.push(options.top ?? -1)) as typeof list.scrollTo;
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
  list.getBoundingClientRect = () => ({ top: 100, height: 200, bottom: 300, left: 0, right: 300, width: 300, x: 0, y: 100, toJSON() {} }) as DOMRect;
  mine.getBoundingClientRect = () => ({ top: 700, height: 80, bottom: 780, left: 0, right: 300, width: 300, x: 0, y: 700, toJSON() {} }) as DOMRect;
  act(() => button.click());
  expect(pageScrolled).toBe(false);
  // 600 px below the list's top, centred in its 200 px: 600 - (200 - 80) / 2.
  expect(listScrolls).toEqual([540]);
  expect(document.activeElement).toBe(mine);
  window.matchMedia = realMatch;
  // No Also box, whatever is skipped.
  expect(el.querySelector('[data-skipped-releases]')).toBeNull();
});

test.skipIf(!hasDom)('behind with no row of yours in the panel: the version and the count, with nowhere to jump', () => {
  const el = render({ model: model() });
  expect(chip(el)?.tagName).toBe('SPAN');
  expect(chip(el)?.textContent).toBe('You have 0.28.19 · 2 releases in between');
});

test.skipIf(!hasDom)('behind with nothing listed in between: the version alone, with nowhere to jump', () => {
  const el = render({ model: model({ current: '0.28.21', since: '0.28.21', skipped: [] }) });
  expect(chip(el)?.tagName).toBe('SPAN');
  expect(chip(el)?.textContent).toContain('0.28.21');
});

test.skipIf(!hasDom)('Update shows only when this release can be installed today, and does what the header Update did', () => {
  expect(whatsNewCanUpdate(model(), update('available'))).toBe(true);
  expect(whatsNewCanUpdate(model(), update('ready'))).toBe(true);
  expect(whatsNewCanUpdate(model(), update('updating'))).toBe(false);
  expect(whatsNewCanUpdate(model(), update('failed'))).toBe(false);
  expect(whatsNewCanUpdate(model(), update('available', '0.28.23'))).toBe(false);
  expect(whatsNewCanUpdate(model(), null)).toBe(false);

  let pressed = 0;
  const el = render({ model: model(), update: update('available'), onUpdate: () => pressed++ });
  const button = el.querySelector<HTMLButtonElement>('[data-whats-new-update]')!;
  // A deliberate action label: the button names the version it installs ("to 0.28.22" may drop visually on a narrow phone).
  expect(button.getAttribute('aria-label')).toBe('Update to 0.28.22');
  expect(button.querySelector('.ib-wn-to')?.textContent).toBe('to 0.28.22');
  act(() => button.click());
  expect(pressed).toBe(1);
  // Behind with update checks off: no Update in the bar.
  act(() => root!.unmount());
  host!.remove();
  const off = render({ model: model(), update: null });
  expect(off.querySelector('[data-whats-new-update]')).toBeNull();
});

test.skipIf(!hasDom)('the bar: the way back on the left, the release on GitHub in a new tab, the old header gone', () => {
  let back = 0;
  const el = render({ model: model(), onBack: () => back++ });
  const bar = el.querySelector('.ib-wn-bar')!;
  const backButton = bar.querySelector<HTMLButtonElement>('[data-whats-new-back]')!;
  expect(backButton.compareDocumentPosition(bar.querySelector('.ib-wn-acts')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  act(() => backButton.click());
  expect(back).toBe(1);
  const github = bar.querySelector<HTMLAnchorElement>('[data-whats-new-github]')!;
  expect(github.href).toBe(model().release_url);
  expect(github.target).toBe('_blank');
  expect(github.rel).toContain('noopener');
  // The sidebar toggle stays on the page.
  expect(bar.querySelector('[data-sidebar="trigger"]')).not.toBeNull();
  // One way back only: the old right-side "← Inbox" and the old meta line are gone.
  expect(el.querySelectorAll('[data-whats-new-back]')).toHaveLength(1);
  expect(el.querySelector('.ib-wn-head')).toBeNull();
  // One line: the product, then the version (no "What's new in Plannotator" above it).
  expect(el.querySelector('.ib-wn-hero h1')?.textContent).toBe('Plannotator 0.28.22');
  expect(el.querySelector('.ib-wn-pre')).toBeNull();
  expect(el.querySelector('.ib-wn-meta')?.textContent).toContain('Released Oct 15, 2026');
});
