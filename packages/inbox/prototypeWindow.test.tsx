/**
 * A question's prototypes on the card and in the window (approval
 * "inbox-question-tradeoffs"):
 * - the card: "Try prototype" hangs from the options' tray; picture tiles
 *   keep only their zoom (no ▷ on a tile: the tab is the one way in); the
 *   option lines leave the meaning line, and Pros and Cons sit in a closed
 *   "Trade-offs" table with no Recommended tag;
 * - the window: it opens on the recommended option's page, ‹ › skip options
 *   with no page, and Pick picks (the card stays unsent) then closes after
 *   a beat.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * App pages are drawn as "runs on your computer" (`remote`), so nothing is
 * fetched.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxInlineImage, InboxMessageWire } from '@plannotator/core/inbox-types';
import { resetImageSrcResolver, setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { inboxImageSrcResolver } from './images';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const { PrototypeWindow, PICK_CLOSE_MS, openingOption } = (hasDom ? await import('./components/PrototypeWindow') : {}) as typeof import('./components/PrototypeWindow');

let root: Root | null = null;
let host: HTMLElement | null = null;

// The tiles' pictures load from a loopback server (a 1x1 GIF for every path), so happy-dom draws them as tiles.
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (c) => c.charCodeAt(0));
let images: ReturnType<typeof Bun.serve> | null = null;
let savedUrl = '';
beforeAll(() => {
  if (!hasDom) return;
  images = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(GIF, { headers: { 'Content-Type': 'image/gif' } }) });
  savedUrl = window.location.href;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(`http://127.0.0.1:${images.port}/`);
});
afterAll(() => {
  if (!hasDom) return;
  if (savedUrl) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(savedUrl);
  images?.stop(true);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetImageSrcResolver();
});

async function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

const ID = 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ';
const app = (n: string) => ({ kind: 'app' as const, siteId: `liv_000000000000000${n}`, url: `http://localhost:4000/checkout?v=${n}` });

function picture(id: string, ref: string): InboxInlineImage {
  return { id, ref, path: `/work/shop/${ref}`, named_path: null, name: ref.split('/').pop()!, kind: 'image', sent_sha256: 'a'.repeat(64), size: 10, sent_at: '', sent_mtime: '', media_type: 'image/png' };
}

test.skipIf(!hasDom)("the card: the tab under the tray, no ▷ on a picture tile, and a closed Trade-offs table without the Recommended tag", async () => {
  const body = [
    ':::question',
    'Which checkout ships?',
    '- [ ] A · Classic — ![A](shots/a.png) today\'s layout',
    '    Pros: known',
    '    Cons: Pay below the fold',
    '    Prototype: http://localhost:4000/checkout?v=a',
    '- [ ] B · Total first — ![B](shots/b.png) the amount first',
    '    Pros: amount seen first',
    '    Prototype: http://localhost:4000/checkout?v=b',
    'Why: it tested better.',
    'Recommended: B · Total first',
    ':::',
  ].join('\n');
  const message = {
    id: ID,
    project_id: 'prj_01K7PPPPPPPPPPPPPPPPPPPPPP',
    thread_id: ID,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' },
    subject: 'Checkout',
    body,
    created_at: '2026-11-09T10:00:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    inline_images: [picture('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'shots/a.png'), picture('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'shots/b.png')],
    live_sites: [app('a'), app('b')].map((s) => ({ id: s.siteId, url: s.url, opened_by: 'agent', opened_at: '2026-11-09T10:00:00.000Z' })),
    questions: [],
  } as unknown as InboxMessageWire;
  const tried: string[] = [];
  setImageSrcResolver(inboxImageSrcResolver);
  await mount(
    <MessageBody
      message={message}
      projectRoot="/work/shop"
      onOpenAttachment={() => {}}
      onOpenInlineImage={() => {}}
      onOpenOptionSet={() => {}}
      onTryPrototype={(key) => tried.push(key)}
      readOnly={false}
      answers={new Map()}
      onPick={() => {}}
      footerFor={() => null}
    />,
  );
  const tiles = Array.from(host!.querySelectorAll<HTMLElement>('[data-question-tile]'));
  expect(tiles).toHaveLength(2);
  for (const tile of tiles) {
    // Only the zoom button: no play, no Try, nothing about a prototype on the tile.
    const buttons = Array.from(tile.querySelectorAll('button'));
    expect(buttons.map((b) => b.hasAttribute('data-question-zoom'))).toEqual([true]);
    expect(tile.textContent).not.toMatch(/prototype|Prototype:|Pros:|Cons:/);
  }
  const tab = host!.querySelector<HTMLButtonElement>('[data-question-tray-host] > .ib-qtab-row > button[data-try-prototype]')!;
  expect(tab.textContent).toBe('Try prototype');
  expect(tab.closest('[data-question-tile]')).toBeNull();
  await act(async () => tab.click());
  expect(tried).toHaveLength(1);

  const toggle = host!.querySelector<HTMLButtonElement>('[data-question-tradeoffs-toggle]')!;
  const table = host!.querySelector<HTMLElement>('[data-question-tradeoffs]')!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(table.hidden).toBe(true);
  // It sits under Why.
  const why = host!.querySelector('[data-question-part="why"]')!;
  expect(why.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => toggle.click());
  expect(table.hidden).toBe(false);
  const rows = Array.from(table.querySelectorAll('[data-question-tradeoffs-row]')).map((r) => r.textContent);
  expect(rows).toEqual(['A · ClassicProsknownConsPay below the fold', 'B · Total firstProsamount seen firstCons-']);
  expect(table.textContent).not.toContain('Recommended');
});

test.skipIf(!hasDom)('the window opens on the recommended page; ‹ › skip an option with none; Pick picks, leaves it unsent and closes after a beat', async () => {
  const options = [
    { label: 'A · Classic', letter: 'A', lettered: true, recommended: false, page: app('a') },
    { label: 'B · Total first', letter: 'B', lettered: true, recommended: false, page: null },
    { label: 'C · Statement', letter: 'C', lettered: true, recommended: true, page: app('c') },
  ];
  const picks: string[] = [];
  let closed = 0;
  await mount(
    <PrototypeWindow
      threadId={ID}
      options={options}
      start={openingOption(options)}
      shared={false}
      picked={[]}
      readOnly={false}
      records={[]}
      attachments={[]}
      remote
      onSaved={() => {}}
      onPick={(label) => picks.push(label)}
      onClose={() => (closed += 1)}
    />,
  );
  const caption = () => host!.querySelector('[data-prototype-caption]')!.getAttribute('data-prototype-caption');
  const step = (dir: 'prev' | 'next') => host!.querySelector<HTMLButtonElement>(`[data-prototype-step="${dir}"]`)!;
  expect(caption()).toBe('C');
  expect(step('next').getAttribute('aria-disabled')).toBe('true');
  await act(async () => step('prev').click());
  // B has no page: one step back is A.
  expect(caption()).toBe('A');
  expect(step('prev').getAttribute('aria-disabled')).toBe('true');
  await act(async () => step('prev').click());
  expect(caption()).toBe('A');
  await act(async () => step('next').click());
  expect(caption()).toBe('C');

  const pick = host!.querySelector<HTMLButtonElement>('[data-prototype-pick]')!;
  await act(async () => pick.click());
  await act(async () => pick.click());
  expect(picks).toEqual(['C · Statement']);
  expect(pick.textContent).toContain('Picked');
  await act(async () => Bun.sleep(PICK_CLOSE_MS / 3));
  expect(closed).toBe(0);
  await act(async () => Bun.sleep(PICK_CLOSE_MS));
  expect(closed).toBe(1);
});
