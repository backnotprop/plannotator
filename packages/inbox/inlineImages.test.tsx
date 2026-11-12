import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxInlineImage, InboxMessageWire } from '@plannotator/core/inbox-types';
import { resetImageSrcResolver, setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { inboxImageSrcResolver, inlineImageRefFromSrc, fitMessageImageElement } from './images';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

let root: Root | null = null;
let host: HTMLElement | null = null;

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

const ID = 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ';

function image(id: string, ref: string): InboxInlineImage {
  return {
    id,
    ref,
    path: `/work/shop/${ref}`,
    named_path: null,
    name: ref.split('/').pop()!,
    kind: 'image',
    sent_sha256: 'a'.repeat(64),
    size: 10,
    sent_at: '2026-10-15T11:22:00.000Z',
    sent_mtime: '2026-10-15T11:20:00.000Z',
    media_type: 'image/png',
  };
}

const B = image('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'design/b.png');
const C = image('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'design/c.png');

function message(body: string, inline: InboxInlineImage[]): InboxMessageWire {
  return {
    id: ID,
    project_id: 'prj_01K7PPPPPPPPPPPPPPPPPPPPPP',
    thread_id: ID,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' },
    subject: 'Checkout',
    body,
    created_at: '2026-10-15T11:22:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    inline_images: inline,
    questions: [],
  } as unknown as InboxMessageWire;
}

async function render(body: string, inline: InboxInlineImage[], opened: InboxInlineImage[]) {
  setImageSrcResolver(inboxImageSrcResolver);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody
        message={message(body, inline)}
        projectRoot="/work/shop"
        onOpenAttachment={() => {}}
        onOpenInlineImage={(img) => opened.push(img)}
        readOnly={false}
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
      />,
    );
  });
}

test('the src the body drew reads back to the ref as written, only for that message', () => {
  expect(inlineImageRefFromSrc(`/api/inbox/messages/${ID}/image?path=${encodeURIComponent('my shots/b.png')}`, ID)).toBe('my shots/b.png');
  expect(inlineImageRefFromSrc(`/api/inbox/messages/msg_other/image?path=b.png`, ID)).toBeNull();
  expect(inlineImageRefFromSrc('/api/inbox/attachments/att_x/image', ID)).toBeNull();
});

test.skipIf(!hasDom)('a captured image opens in the viewer on a click, Enter or Space, markdown and raw HTML alike; an uncaptured one opens the lightbox', async () => {
  const opened: InboxInlineImage[] = [];
  const body = ['Two directions:', '', '![B](design/b.png)', '', '<p><img src="design/c.png" alt="C"></p>', '', '![gone](design/gone.png)'].join('\n');
  await render(body, [B, C], opened);
  const img = (alt: string) => host!.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)!;
  expect(img('B').getAttribute('role')).toBe('button');
  expect(img('B').tabIndex).toBe(0);
  expect(img('B').getAttribute('aria-label')).toBe('Open b.png, B');
  expect(img('B').getAttribute('data-inline-image')).toBe(B.id);
  expect(img('C').getAttribute('data-inline-image')).toBe(C.id);
  expect(img('gone').getAttribute('role')).toBe('button');
  expect(img('gone').getAttribute('aria-label')).toBe('Open gone.png, gone');
  expect(img('gone').getAttribute('data-inline-image')).toBeNull();

  await act(async () => img('B').click());
  await act(async () => img('C').click());
  expect(opened.map((i) => i.id)).toEqual([B.id, C.id]);
  expect(document.querySelector('[data-image-lightbox]')).toBeNull();
  await act(async () => img('gone').click());
  expect(opened.map((i) => i.id)).toEqual([B.id, C.id]);
  const box = document.querySelector<HTMLElement>('[data-image-lightbox]')!;
  expect(box).not.toBeNull();
  expect(box.querySelector('img')!.getAttribute('src')).toBe(img('gone').getAttribute('src'));
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  expect(document.querySelector('[data-image-lightbox]')).toBeNull();
  await act(async () => {
    img('gone').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  expect(document.querySelector('[data-image-lightbox]')).not.toBeNull();
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });

  for (const key of ['Enter', ' ']) {
    await act(async () => {
      img('C').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  }
  expect(opened.map((i) => i.id)).toEqual([B.id, C.id, C.id, C.id]);
});

test.skipIf(!hasDom)('a captured picture wider than 1600 loads as a smaller copy at its own width; a narrower or uncaptured one as it is', async () => {
  const opened: InboxInlineImage[] = [];
  const wide = { ...image('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'shots/wide.png'), width: 3840, height: 2242 };
  const narrow = { ...image('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'shots/narrow.png'), width: 1200, height: 800 };
  const body = ['![wide](shots/wide.png)', '', '![narrow](shots/narrow.png)', '', '<p><img src="shots/wide.png" alt="raw"></p>', '', '![later](shots/later.png)'].join('\n');
  await render(body, [wide, narrow], opened);
  const img = (alt: string) => host!.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)!;
  const route = (ref: string) => `/api/inbox/messages/${ID}/image?path=${encodeURIComponent(ref)}`;
  expect(img('wide').getAttribute('src')).toBe(`${route('shots/wide.png')}&w=1600`);
  expect(img('wide').getAttribute('width')).toBe('3840');
  expect(img('wide').getAttribute('decoding')).toBe('async');
  expect(img('raw').getAttribute('src')).toBe(`${route('shots/wide.png')}&w=1600`);
  expect(img('raw').getAttribute('width')).toBe('3840');
  expect(img('narrow').getAttribute('src')).toBe(route('shots/narrow.png'));
  expect(img('narrow').hasAttribute('width')).toBe(false);
  expect(img('later').getAttribute('src')).toBe(route('shots/later.png'));
  expect(img('wide').getAttribute('data-inline-image')).toBe(wide.id);
  await act(async () => img('wide').click());
  expect(opened.map((i) => i.id)).toEqual([wide.id]);
});

test.skipIf(!hasDom)('a picture loaded as a smaller copy is measured as the original; a size the agent wrote is the box it asked for', () => {
  const tall = document.createElement('img');
  tall.setAttribute('src', `/api/inbox/messages/${ID}/image?path=t.png&w=1600`);
  tall.setAttribute('width', '2400');
  Object.defineProperty(tall, 'naturalWidth', { value: 1600 });
  Object.defineProperty(tall, 'naturalHeight', { value: 6400 });
  expect(fitMessageImageElement(tall)).toEqual({ width: 2400, height: 9600 });
  expect(tall.getAttribute('data-ib-fit')).toBe('long');
  expect(tall.style.getPropertyValue('--ib-nw')).toBe('2400');
  expect(tall.style.getPropertyValue('--ib-nh')).toBe('9600');
  const sized = document.createElement('img');
  sized.setAttribute('src', `/api/inbox/messages/${ID}/image?path=s.png`);
  sized.setAttribute('width', '200');
  Object.defineProperty(sized, 'naturalWidth', { value: 400 });
  Object.defineProperty(sized, 'naturalHeight', { value: 300 });
  expect(fitMessageImageElement(sized)).toEqual({ width: 200, height: 150 });
  expect(sized.getAttribute('data-ib-fit')).toBe('');
  const unknown = document.createElement('img');
  expect(fitMessageImageElement(unknown)).toBeNull();
  expect(unknown.hasAttribute('data-ib-fit')).toBe(false);
});

const sized = (id: string, ref: string, width: number, height: number): InboxInlineImage => ({ ...image(id, ref), width, height });
const WINDOW_SHOT = sized('att_01K7WWWWWWWWWWWWWWWWWWWWW1', 'shots/window.png', 2880, 1800);
const PAGE_SHOT = sized('att_01K7WWWWWWWWWWWWWWWWWWWWW2', 'shots/page.png', 800, 4000);
const ICON_SHOT = sized('att_01K7WWWWWWWWWWWWWWWWWWWWW3', 'shots/icon.png', 48, 48);

test.skipIf(!hasDom)("a picture's box is held from its recorded size before it loads; one with no record waits for its load", async () => {
  const body = ['![window](shots/window.png)', '', '![icon](shots/icon.png)', '', '![later](shots/later.png)'].join('\n');
  await render(body, [WINDOW_SHOT, ICON_SHOT], []);
  const img = (alt: string) => host!.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)!;
  expect(img('window').naturalWidth).toBe(0);
  expect(img('window').getAttribute('data-ib-fit')).toBe('');
  expect(img('window').style.getPropertyValue('--ib-nw')).toBe('2880');
  expect(img('window').style.getPropertyValue('--ib-nh')).toBe('1800');
  expect(img('icon').style.getPropertyValue('--ib-nw')).toBe('48');
  expect(host!.querySelector('[data-ib-imgmore]')).toBeNull();
  expect(img('later').hasAttribute('data-ib-fit')).toBe(false);
  Object.defineProperty(img('later'), 'naturalWidth', { value: 1200 });
  Object.defineProperty(img('later'), 'naturalHeight', { value: 800 });
  await act(async () => void img('later').dispatchEvent(new Event('load')));
  expect(img('later').getAttribute('data-ib-fit')).toBe('');
  expect(img('later').style.getPropertyValue('--ib-nw')).toBe('1200');
});

test.skipIf(!hasDom)('a very long picture shows its top with "Show all", a button of its own that opens it in place; the picture still opens the viewer', async () => {
  const opened: InboxInlineImage[] = [];
  await render('![The whole cart page](shots/page.png)\n\nAfter.', [PAGE_SHOT], opened);
  const img = host!.querySelector<HTMLImageElement>('img[alt="The whole cart page"]')!;
  expect(img.getAttribute('data-ib-fit')).toBe('long');
  expect(img.hasAttribute('data-ib-cut')).toBe(true);
  const button = () => host!.querySelector<HTMLButtonElement>('[data-ib-imgmore] > button')!;
  expect(button().getAttribute('aria-label')).toBe('Show all of The whole cart page');
  expect(button().getAttribute('aria-expanded')).toBe('false');
  expect(host!.querySelector('.ib-body')!.textContent).not.toContain('Show');
  await act(async () => button().click());
  expect(opened).toEqual([]);
  expect(img.hasAttribute('data-ib-open')).toBe(true);
  expect(button().getAttribute('aria-label')).toBe('Show less of The whole cart page');
  expect(button().getAttribute('aria-expanded')).toBe('true');
  await act(async () => img.click());
  expect(opened.map((i) => i.id)).toEqual([PAGE_SHOT.id]);
  await act(async () => window.dispatchEvent(new Event('resize')));
  expect(img.hasAttribute('data-ib-open')).toBe(true);
  await act(async () => button().click());
  expect(img.hasAttribute('data-ib-open')).toBe(false);
  expect(button().getAttribute('aria-label')).toBe('Show all of The whole cart page');
  expect(host!.querySelectorAll('[data-ib-imgmore]')).toHaveLength(1);
});

test.skipIf(!hasDom)('a picture with no alt text is "this picture"; a long one that fits under the cap has no control', async () => {
  const strip = sized('att_01K7WWWWWWWWWWWWWWWWWWWWW4', 'shots/strip.png', 60, 240);
  await render('![](shots/page.png)\n\n![strip](shots/strip.png)', [PAGE_SHOT, strip], []);
  const buttons = [...host!.querySelectorAll<HTMLButtonElement>('[data-ib-imgmore] > button')];
  expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Show all of this picture']);
  expect(host!.querySelector<HTMLImageElement>('img[alt="strip"]')!.hasAttribute('data-ib-cut')).toBe(false);
});

test.skipIf(!hasDom)("a question's picture choices are left alone: no box of the message rule, no Show all", async () => {
  const body = [':::question', 'Which page?', '', '- [ ] A — ![A](shots/page.png) the long one', '- [ ] B — ![B](shots/window.png) the wide one', ':::'].join('\n');
  await render(body, [PAGE_SHOT, WINDOW_SHOT], []);
  const pictures = [...host!.querySelectorAll<HTMLImageElement>('img[data-question-picture]')];
  expect(pictures.length).toBeGreaterThanOrEqual(2);
  for (const picture of pictures) {
    expect(picture.hasAttribute('data-ib-fit')).toBe(false);
    expect(picture.style.getPropertyValue('--ib-nw')).toBe('');
  }
  expect(host!.querySelector('[data-ib-imgmore]')).toBeNull();
});

test.skipIf(!hasDom)('an image that fails to load is its alt text and opens nothing, markdown and raw HTML alike; a data: image is not a button', async () => {
  const opened: InboxInlineImage[] = [];
  const body = ['![gone](design/gone.png)', '', '<p><img src="design/raw.png" alt="raw gone"></p>', '', '![dot](data:image/gif;base64,R0lGODlhAQABAAAAACw=)'].join('\n');
  await render(body, [], opened);
  for (const alt of ['gone', 'raw gone']) {
    const failed = host!.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)!;
    expect(failed.getAttribute('role')).toBe('button');
    await act(async () => {
      failed.dispatchEvent(new Event('error'));
    });
    expect(host!.querySelector(`img[alt="${alt}"]`)).toBeNull();
  }
  const chips = [...host!.querySelectorAll<HTMLElement>('[data-image-unavailable]')];
  expect(chips.map((chip) => chip.textContent)).toEqual(['gone', 'raw gone']);
  for (const chip of chips) await act(async () => chip.click());
  expect(document.querySelector('[data-image-lightbox]')).toBeNull();
  const dot = host!.querySelector<HTMLImageElement>('img[alt="dot"]')!;
  expect(dot.getAttribute('role')).toBeNull();
  await act(async () => dot.click());
  expect(document.querySelector('[data-image-lightbox]')).toBeNull();
  expect(opened).toEqual([]);
});

test.skipIf(!hasDom)('a picture choice carries the size recorded when the message was sent, before it loads; one with no record carries none', async () => {
  const phone = { ...image('att_01K7PPPPPPPPPPPPPPPPPPPPPP', 'design/phone.png'), width: 1170, height: 2532 };
  const body = [':::question', 'Which header?', '', '- [ ] A — ![A](design/phone.png) title only', '- [ ] B — ![B](design/b.png) title and project', ':::'].join('\n');
  await render(body, [phone, B], []);
  const tiles = [...host!.querySelectorAll<HTMLElement>('[data-question-tile]')];
  expect(tiles).toHaveLength(2);
  const box = (tile: HTMLElement) => tile.querySelector<HTMLElement>('[data-question-tile-picture]')!;
  expect(box(tiles[0]!).style.getPropertyValue('--question-picture-ratio')).toBe('1170 / 2532');
  expect(tiles[0]!.getAttribute('data-question-tile-shape')).toBe('tall');
  expect(box(tiles[1]!).style.getPropertyValue('--question-picture-ratio')).toBe('');
  expect(tiles[1]!.hasAttribute('data-question-tile-shape')).toBe(false);
  expect(host!.querySelector('[data-question-tiles]')!.getAttribute('data-question-tiles-shape')).toBe('mixed');
});
