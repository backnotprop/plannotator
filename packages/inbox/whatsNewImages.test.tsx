/**
 * Images on the What's new page: an image the Inbox saved loads from its own
 * route (never from GitHub: the window's CSP allows only its own origin), and
 * one it did not save is drawn as its alt text in a quiet chip, never as a
 * broken image.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WhatsNewModel } from './api';

const hasDom = typeof document !== 'undefined';
// Updates.tsx draws the notes with ui's Viewer, which reads `window` at module-eval time.
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

const SAVED = 'https://github.com/user-attachments/assets/saved-one';
const SAVED_HTML = 'https://github.com/user-attachments/assets/saved-two';
const MISSING = 'https://github.com/user-attachments/assets/not-saved';
const ELSEWHERE = 'https://example.com/tracker.png';

const model = (images: string[] | undefined): WhatsNewModel => ({
  version: '0.28.25',
  current: '0.28.25',
  since: '0.28.24',
  published_at: '2026-10-20T12:00:00Z',
  release_url: 'https://github.com/backnotprop/plannotator/releases/tag/v0.28.25',
  notes: [
    'Images in What\'s new.',
    '',
    `![The new header](${SAVED})`,
    '',
    `<img width="600" alt="The new chip" src="${SAVED_HTML}" />`,
    '',
    `![A screenshot we did not keep](${MISSING})`,
    '',
    `![From elsewhere](${ELSEWHERE})`,
  ].join('\n'),
  skipped: [],
  ...(images ? { images } : {}),
});

/** Every <img> src the page put in the DOM (this DOM has no server, so a load fails and ui swaps the image for its chip). */
let drawn: string[] = [];
if (hasDom) {
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (this.tagName === 'IMG' && name === 'src') drawn.push(value);
    return setAttribute.call(this, name, value);
  };
}

function render(m: WhatsNewModel) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  drawn = [];
  act(() => {
    root = createRoot(host!);
    root.render(
      <SidebarProvider>
        <WhatsNewPage model={m} error={null} update={null} onBack={() => {}} onUpdate={() => {}} />
      </SidebarProvider>,
    );
  });
  return host;
}

const routeFor = (src: string) => `/api/inbox/whats-new/image?version=0.28.25&src=${encodeURIComponent(src)}`;

test.skipIf(!hasDom)('saved images load from the Inbox; the rest are their alt text, never a remote <img>', async () => {
  const el = render(model([SAVED, SAVED_HTML]));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const srcs = drawn;
  expect(srcs).toContain(routeFor(SAVED));
  // The raw-HTML <img> is decided the same way (ui's host media resolver);
  // this DOM cannot draw a raw HTML block, so the e2e screenshot shows it.
  // Nothing points at another origin.
  for (const src of srcs) expect(src).toStartWith('/api/inbox/whats-new/image?');
  const chips = [...el.querySelectorAll('[data-image-unavailable]')].map((chip) => chip.textContent);
  expect(chips).toContain('A screenshot we did not keep');
  expect(chips).toContain('From elsewhere');
  expect(el.querySelector('[title^="This image is not saved"]')?.textContent).toBe('A screenshot we did not keep');
});

test.skipIf(!hasDom)('an older Inbox (no images field) loads no image at all', async () => {
  const el = render(model(undefined));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(drawn).toEqual([]);
  expect(el.querySelectorAll('[data-image-unavailable]')).toHaveLength(3);
});
