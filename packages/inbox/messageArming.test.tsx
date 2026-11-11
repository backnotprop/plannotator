/** happy-dom lays nothing out: each article's box is placed by hand and the IntersectionObserver is a stub the test reports through. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { ARM_MARGIN, DISARM_MARGIN } from './messageArming';
import { threadLink } from './rowMenu';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'shop-abcdef', name: 'shop', root: '/work/shop', created_at: '2026-11-08T09:00:00.000Z' };
const CLAUDE: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const IDS = Array.from({ length: 6 }, (_, i) => `msg_01M62DTT05NJ59ZR4AJCDJ70${String(i).padStart(2, '0')}`);
const TOP = 2000;

function thread(): InboxThread {
  const messages: InboxMessageWire[] = IDS.map((id, i) => ({
    id,
    project_id: PROJECT.id,
    thread_id: IDS[0]!,
    reply_to: i === 0 ? null : IDS[0]!,
    author: CLAUDE,
    subject: i === 0 ? 'Checkout redesign' : null,
    body: `Step ${i + 1}: the checkout page, a little further on.`,
    created_at: `2026-11-08T19:${String(10 + i).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    seq: 10 + i,
  }));
  return { thread_id: IDS[0]!, project: PROJECT, subject: 'Checkout redesign', thread_name: 'checkout', resolved_at: null, messages };
}

type Report = (entries: { target: Element; isIntersecting: boolean }[]) => void;
let observers: { margin: string; report: Report }[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedIO: unknown;
let savedRect: PropertyDescriptor | undefined;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
  observers = [];
  savedIO = (globalThis as Record<string, unknown>).IntersectionObserver;
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    constructor(report: Report, options: { rootMargin?: string } = {}) {
      observers.push({ margin: options.rootMargin ?? '', report });
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  savedRect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const at = this instanceof HTMLElement && this.dataset.messageArticle ? IDS.indexOf(this.dataset.messageArticle) * TOP : 0;
    return { top: at, bottom: at + 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: at, toJSON: () => ({}) } as DOMRect;
  };
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('.ib-pm-pos, .ib-pm-scrim, [data-pn-tooltip]').forEach((n) => n.remove());
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).IntersectionObserver = savedIO;
  if (savedRect) Object.defineProperty(Element.prototype, 'getBoundingClientRect', savedRect);
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 60; i += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function render() {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const t = thread();
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={t}
        sent={null}
        lookSeq={0}
        phone={false}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        linkOf={(messageId) => threadLink(t.thread_id, { url: 'http://localhost:4321/', via: 'local' }, 'http://127.0.0.1:4321', messageId)}
      />,
    );
  });
  await settle();
}

const article = (id: string) => document.querySelector<HTMLElement>(`[data-message-article="${id}"]`)!;
const more = (id: string) => document.querySelector<HTMLButtonElement>(`[data-message-more="${id}"]`)!;
const head = (id: string) => article(id).querySelector<HTMLElement>('[data-open-head]')!;
const tooltipTriggers = (id: string) => article(id).querySelectorAll('[data-base-ui-tooltip-trigger]').length;
const armed = (id: string) => tooltipTriggers(id) > 0;

async function report(id: string, near: boolean, within: boolean) {
  await act(async () => {
    for (const o of observers) {
      if (o.margin === ARM_MARGIN) o.report([{ target: article(id), isIntersecting: near }]);
      if (o.margin === DISARM_MARGIN) o.report([{ target: article(id), isIntersecting: within }]);
    }
  });
  await settle();
}

async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
}

function looks(el: Element): string {
  const skip = (name: string) => name === 'id' || name.startsWith('data-base-ui') || name === 'aria-describedby' || name === 'style' || name === 'tabindex' || name === 'data-trigger-disabled';
  const attrs = el
    .getAttributeNames()
    .filter((name) => !skip(name))
    .sort()
    .map((name) => `${name}=${JSON.stringify(el.getAttribute(name))}`);
  const children = [...el.childNodes].map((node) => (node.nodeType === 1 ? looks(node as Element) : node.nodeType === 3 ? JSON.stringify(node.textContent) : '')).join('');
  return `<${el.tagName.toLowerCase()} ${attrs.join(' ')}>${children}</>`;
}

test.skipIf(!hasDom)('a message in view is armed when drawn; one far from it draws the same controls with no tooltip or menu behind them', async () => {
  await render();
  expect(observers.map((o) => o.margin).sort()).toEqual([ARM_MARGIN, DISARM_MARGIN].sort());
  expect(armed(IDS[0]!)).toBe(true);
  for (const id of IDS.slice(2)) expect(armed(id)).toBe(false);
  for (const id of IDS) {
    expect(more(id).getAttribute('aria-label')).toStartWith('More: Claude Code, ');
    expect(head(id).querySelector('button[aria-label="Reply"]')).not.toBeNull();
  }
});

test.skipIf(!hasDom)("arming changes nothing a person sees: the far message's head line and ⋯ look the same before and after", async () => {
  await render();
  const id = IDS[4]!;
  const before = { head: looks(head(id)), more: looks(more(id)) };
  await report(id, true, true);
  expect(armed(id)).toBe(true);
  expect(looks(more(id))).toBe(before.more);
  expect(looks(head(id))).toBe(before.head);
});

test.skipIf(!hasDom)("a press on a far message's ⋯ opens its menu at once", async () => {
  await render();
  const id = IDS[5]!;
  expect(armed(id)).toBe(false);
  await press(more(id));
  await until(() => !!document.querySelector(`[data-message-menu="${id}"]`), 'the message menu');
  const items = [...document.querySelectorAll(`[data-message-menu="${id}"] [role="menuitem"]`)].map((el) => el.textContent?.trim());
  expect(items).toEqual(['Copy message', 'Copy link to message', 'Copy thread']);
});

// The window's styles are scoped to its root (`.pn-inbox svg.ib-ic`): a menu drawn on the page's body shows filled black icons.
test.skipIf(!hasDom)("a far message's menu is drawn inside the window's root, opened by a press or once it comes near", async () => {
  await render();
  const pressed = IDS[5]!;
  await press(more(pressed));
  await until(() => !!document.querySelector(`[data-message-menu="${pressed}"]`), 'the pressed message menu');
  expect(document.querySelector(`[data-message-menu="${pressed}"]`)!.closest('.pn-inbox')).toBe(host);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await until(() => !document.querySelector(`[data-message-menu="${pressed}"]`), 'the pressed menu to close');
  const scrolled = IDS[3]!;
  await report(scrolled, true, true);
  expect(armed(scrolled)).toBe(true);
  await press(more(scrolled));
  await until(() => !!document.querySelector(`[data-message-menu="${scrolled}"]`), 'the armed message menu');
  expect(document.querySelector(`[data-message-menu="${scrolled}"]`)!.closest('.pn-inbox')).toBe(host);
});

test.skipIf(!hasDom)('a message that goes far from the view is disarmed, but never while focus is inside it', async () => {
  await render();
  const [kept, left] = [IDS[2]!, IDS[3]!];
  await report(kept, true, true);
  await report(left, true, true);
  expect(armed(kept) && armed(left)).toBe(true);
  await act(async () => head(kept).querySelector<HTMLButtonElement>('button[data-fold-head]')!.focus());
  await report(kept, false, false);
  await report(left, false, false);
  expect(armed(left)).toBe(false);
  expect(armed(kept)).toBe(true);
  expect(document.activeElement?.closest('[data-message-article]')?.getAttribute('data-message-article')).toBe(kept);
});

test.skipIf(!hasDom)('focus that lands in a far message stays on the same control once its controls are armed', async () => {
  await render();
  const id = IDS[5]!;
  expect(armed(id)).toBe(false);
  await act(async () => more(id).focus());
  await settle();
  expect(armed(id)).toBe(true);
  // Compared as a boolean: bun's diff of two happy-dom elements never ends.
  expect(document.activeElement?.isConnected).toBe(true);
  expect(document.activeElement?.getAttribute('data-message-more')).toBe(id);
  expect(document.activeElement === more(id)).toBe(true);
});
