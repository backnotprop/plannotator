import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WhatsNewModel, WhatsNewRelease, WhatsNewReleasesModel } from './api';

const hasDom = typeof document !== 'undefined';
const { WhatsNewPage } = (hasDom ? await import('./components/Updates') : {}) as typeof import('./components/Updates');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const release = (version: string, over: Partial<WhatsNewRelease> = {}): WhatsNewRelease => ({
  version,
  published_at: '2026-11-05T12:00:00Z',
  tldr: [],
  listed: null,
  sentence: null,
  saved: true,
  ...over,
});

const RELEASES: WhatsNewReleasesModel = {
  latest: '0.28.53',
  current: '0.28.53',
  refreshing: false,
  offline: false,
  fetched_at: null,
  releases: [
    release('0.28.53', {
      published_at: '2026-11-08T12:00:00Z',
      tldr: [
        { label: 'New', text: 'Start an agent in a new folder' },
        { label: 'New', text: '"+" on each project row' },
        { label: 'Removed', text: '`PLANNOTATOR_INBOX_ASK_AI`: Ask AI is always on' },
        { label: 'Off by default', text: 'Bro mode' },
      ],
    }),
    release('0.28.50', { tldr: [{ label: 'Changed', text: 'The Inbox opens faster' }, { label: 'Fixed', text: 'HTML prints in full' }, { label: 'New', text: 'Third line' }] }),
    release('0.28.43', { listed: { text: 'Voice dictation, combine projects', in: '0.28.53' }, saved: false }),
    release('0.28.42', { sentence: 'Choose how your list looks.' }),
    release('0.28.39', { saved: false }),
  ],
};

const model = (version: string, over: Partial<WhatsNewModel> = {}): WhatsNewModel => ({
  version,
  current: '0.28.53',
  since: '0.28.53',
  published_at: '2026-11-08T12:00:00Z',
  release_url: `https://github.com/backnotprop/plannotator/releases/tag/v${version}`,
  notes: `Notes of ${version}.`,
  tldr: [],
  skipped: [],
  ...over,
});

interface Props {
  version: string;
  model: WhatsNewModel | null;
  error?: { message: string; code: string | null } | null;
  onOpen?: (version: string) => void;
  onRetry?: () => void;
}

function page(p: Props) {
  return (
    <SidebarProvider>
      <WhatsNewPage
        version={p.version}
        model={p.model}
        error={p.error ?? null}
        releases={RELEASES}
        update={null}
        onBack={() => {}}
        onUpdate={() => {}}
        onOpenRelease={p.onOpen ?? (() => {})}
        onRetry={p.onRetry ?? (() => {})}
      />
    </SidebarProvider>
  );
}

function render(p: Props) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(page(p));
  });
  return host;
}
const rerender = (p: Props) => act(() => root!.render(page(p)));

const panel = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-whats-new-panel]')!;
const selected = (el: HTMLElement) => [...panel(el).querySelectorAll<HTMLElement>('[aria-current="page"]')].map((a) => a.dataset.whatsNewRelease);

test.skipIf(!hasDom)('the selected row follows the release the page shows, and each row is a link to its #whats-new=', () => {
  const el = render({ version: '0.28.53', model: model('0.28.53') });
  expect(selected(el)).toEqual(['0.28.53']);
  rerender({ version: '0.28.50', model: model('0.28.50') });
  expect(selected(el)).toEqual(['0.28.50']);
  rerender({ version: '0.28.43', model: null });
  expect(selected(el)).toEqual(['0.28.43']);
  const links = [...panel(el).querySelectorAll<HTMLAnchorElement>('a[data-whats-new-release]')];
  expect(links.map((a) => a.getAttribute('href'))).toEqual(['#whats-new=0.28.53', '#whats-new=0.28.50', '#whats-new=0.28.43', '#whats-new=0.28.42', '#whats-new=0.28.39']);
});

test.skipIf(!hasDom)('a plain click switches the notes; Cmd-click is left to the browser (a new tab)', () => {
  const opened: string[] = [];
  const el = render({ version: '0.28.53', model: model('0.28.53'), onOpen: (v) => opened.push(v) });
  const row = panel(el).querySelector<HTMLAnchorElement>('[data-whats-new-release="0.28.50"]')!;
  const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  act(() => void row.dispatchEvent(plain));
  expect(plain.defaultPrevented).toBe(true);
  expect(opened).toEqual(['0.28.50']);
  const meta = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
  act(() => void row.dispatchEvent(meta));
  expect(meta.defaultPrevented).toBe(false);
  expect(opened).toEqual(['0.28.50']);
  act(() => panel(el).querySelector<HTMLAnchorElement>('[data-whats-new-release="0.28.53"]')!.click());
  expect(opened).toEqual(['0.28.50']);
});

test.skipIf(!hasDom)('the Latest card: compact while the latest release is open, full with every labelled line otherwise', () => {
  const el = render({ version: '0.28.53', model: model('0.28.53') });
  const card = () => panel(el).querySelector<HTMLElement>('[data-whats-new-latest]')!;
  expect(card().dataset.whatsNewLatest).toBe('compact');
  expect(card().querySelector('.ib-wn-cl, .ib-wn-rl, .ib-wn-rp, li')).toBeNull();
  expect(card().textContent).not.toContain('Start an agent');
  expect(card().querySelector('.ib-wn-rv')!.textContent).toBe('0.28.53You have this');
  expect(card().querySelector('.ib-wn-rd')!.textContent).not.toBe('');

  rerender({ version: '0.28.50', model: model('0.28.50') });
  expect(card().dataset.whatsNewLatest).toBe('full');
  const lines = [...card().querySelectorAll('.ib-wn-cl li')];
  expect(lines).toHaveLength(4);
  expect(lines.map((li) => li.querySelector('.ib-wn-dot')?.className)).toEqual(['ib-wn-dot ib-wn-d-new', 'ib-wn-dot ib-wn-d-new', 'ib-wn-dot ib-wn-d-removed', 'ib-wn-dot ib-wn-d-off']);
  expect(lines[2]!.querySelector('code')?.textContent).toBe('PLANNOTATOR_INBOX_ASK_AI');
});

test.skipIf(!hasDom)("each earlier row: two TL;DR lines, else the release list's line, else the first sentence, else No summary", () => {
  const el = render({ version: '0.28.53', model: model('0.28.53') });
  const words = (v: string) => panel(el).querySelector(`[data-whats-new-release="${v}"]`)!.querySelector('.ib-wn-rl, .ib-wn-rp')!;
  expect([...words('0.28.50').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['The Inbox opens faster', 'HTML prints in full']);
  expect(words('0.28.43').textContent).toBe('Voice dictation, combine projects');
  expect(words('0.28.42').textContent).toBe('Choose how your list looks.');
  expect(words('0.28.39').textContent).toBe('No summary');
  expect(panel(el).querySelector('[data-whats-new-release="0.28.50"] .ib-wn-rd')?.textContent).toBe('Nov 5');
  expect(panel(el).querySelector('.ib-wn-phead')?.textContent).toBe('Releases5');
});

test.skipIf(!hasDom)('the TL;DR ledger: each label with its dot in one column; none in the notes, no ledger', () => {
  const tldr = [
    { label: 'New', text: 'Start an agent in a new folder' },
    { label: 'Fixed', text: 'Prints in full' },
    { label: 'Security', text: 'Tokens rotate' },
  ];
  const el = render({ version: '0.28.53', model: model('0.28.53', { tldr }) });
  const ledger = el.querySelector('[data-whats-new-tldr]')!;
  expect(ledger.querySelector('h2')?.textContent).toBe('TL;DR');
  const rows = [...ledger.querySelectorAll('li')].map((li) => [li.querySelector('.ib-wn-tl')?.textContent, li.querySelector('.ib-wn-dot')?.className ?? null, li.querySelector('.ib-wn-tt')?.textContent]);
  expect(rows).toEqual([
    ['New', 'ib-wn-dot ib-wn-d-new', 'Start an agent in a new folder'],
    ['Fixed', 'ib-wn-dot ib-wn-d-fixed', 'Prints in full'],
    ['Security', null, 'Tokens rotate'],
  ]);
  expect(ledger.compareDocumentPosition(el.querySelector('.ib-wn-body')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  rerender({ version: '0.28.50', model: model('0.28.50') });
  expect(el.querySelector('[data-whats-new-tldr]')).toBeNull();
  expect(el.textContent).toContain('Notes of 0.28.50.');
});

test.skipIf(!hasDom)('loading: the heading and the known line at once, then "Getting the notes from GitHub"', () => {
  const el = render({ version: '0.28.43', model: null });
  expect(el.querySelector('.ib-wn-hero h1')?.textContent).toBe('Plannotator 0.28.43');
  expect(el.querySelector('.ib-wn-meta')?.textContent).toContain('Released Nov 5, 2026');
  expect(el.querySelector('[data-whats-new-known] .ib-wn-known')?.textContent).toBe('Voice dictation, combine projects');
  expect(el.querySelector('[data-whats-new-known] .ib-wn-from')?.textContent).toBe("From the release list in 0.28.53's notes");
  expect(el.querySelector('[data-whats-new-loading] [role="status"]')?.textContent).toBe('Getting the notes from GitHub');
  rerender({ version: '0.28.39', model: null });
  expect(el.querySelector('[data-whats-new-known]')).toBeNull();
  expect(el.querySelectorAll('.ib-wn-tldr .ib-wn-sk').length).toBe(3);
});

test.skipIf(!hasDom)("offline and not saved: Can't reach GitHub, with Try again and Open on GitHub", () => {
  let retried = 0;
  const el = render({ version: '0.28.43', model: null, error: { message: "Can't reach GitHub for these release notes.", code: 'notes_unreachable' }, onRetry: () => retried++ });
  const card = el.querySelector<HTMLElement>('[data-whats-new-missing]')!;
  expect(card.dataset.whatsNewMissing).toBe('unreachable');
  expect(card.querySelector('h2')?.textContent).toBe("Can't reach GitHub");
  expect(card.textContent).toContain("The notes for 0.28.43 aren't on this computer yet.");
  act(() => card.querySelector<HTMLButtonElement>('[data-whats-new-retry]')!.click());
  expect(retried).toBe(1);
  const github = card.querySelector<HTMLAnchorElement>('[data-whats-new-open-github]')!;
  expect(github.href).toBe('https://github.com/backnotprop/plannotator/releases/tag/v0.28.43');
  expect(github.target).toBe('_blank');
  expect(el.querySelector('[data-whats-new-known]')).not.toBeNull();
  expect(el.querySelector('.ib-error')).toBeNull();
  rerender({ version: '0.28.43', model: null, error: { message: 'These release notes aren\'t saved on this computer, and update checks are off.', code: 'notes_not_found' } });
  expect(el.querySelector('[data-whats-new-retry]')).toBeNull();
  expect(el.querySelector('[data-whats-new-missing] p')?.textContent).toContain('update checks are off');
});

test.skipIf(!hasDom)('the version picker opens the sheet with the same list; a row there switches and closes it', () => {
  const opened: string[] = [];
  const el = render({ version: '0.28.50', model: model('0.28.50'), onOpen: (v) => opened.push(v) });
  const picker = el.querySelector<HTMLButtonElement>('[data-whats-new-picker]')!;
  expect(picker.textContent).toBe('0.28.50');
  expect(picker.getAttribute('aria-haspopup')).toBe('dialog');
  act(() => picker.click());
  const sheet = () => el.querySelector<HTMLElement>('[data-dialog="whats-new-releases"]');
  expect(sheet()).not.toBeNull();
  expect([...sheet()!.querySelectorAll('[aria-current="page"]')].map((a) => (a as HTMLElement).dataset.whatsNewRelease)).toEqual(['0.28.50']);
  act(() => sheet()!.querySelector<HTMLAnchorElement>('[data-whats-new-release="0.28.42"]')!.click());
  expect(opened).toEqual(['0.28.42']);
  expect(sheet()).toBeNull();
});
