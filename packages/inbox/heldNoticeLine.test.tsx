/**
 * The held list's "N new" line stays ONE line (the owner, 2026-11-02: "1 new in appnotes ·
 * Users/ramos/workspaces/projects" wrapped onto two lines beside Show and "looks bugged out"). The
 * count and Show never shrink and the project's name is the part that is cut with "…"; while it is
 * cut, the whole line is the tooltip. The page's real stylesheet is loaded, so the rules that keep it
 * on one line are the ones the window uses. happy-dom has no layout, so a test gives the project's
 * name the widths that make it cut.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
let sheet: HTMLStyleElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  sheet?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  root = null;
  host = null;
  sheet = null;
});

/** The `.ib-notice` rules of the window's stylesheet (outside the phone block), as the page has them. */
function noticeRules(): string {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  return css
    .split('\n')
    .filter((line) => /^\.ib-notice/.test(line))
    .join('\n');
}

function render(notice: { count: number; project?: string | null } | null): HTMLElement {
  sheet = document.createElement('style');
  sheet.textContent = noticeRules();
  document.head.append(sheet);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} sections={[]} filtered={false} narrow selectedThreadId={null} notice={notice} onShowNew={() => {}} onOpen={() => {}} phone={false} />
        </div>
      </SidebarProvider>,
    );
  });
  return host;
}

function sized(node: HTMLElement, scroll: number, client: number) {
  Object.defineProperty(node, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => client });
}

/** The pointer comes to rest on `target`, the way a mouse does. */
function hover(target: HTMLElement) {
  act(() => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { bubbles: type !== 'pointerenter' && type !== 'mouseenter', cancelable: true, pointerType: 'mouse', clientX: 10, clientY: 10 } as PointerEventInit));
    }
  });
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** A popup outside `el` whose text is exactly `text`: the tooltip, portaled to the body. */
const tooltipWith = (el: HTMLElement, text: string) => [...document.body.querySelectorAll('*')].some((n) => !el.contains(n) && n.children.length === 0 && n.textContent === text);

const LONG = 'appnotes · a-very-long-parent-folder-name-that-does-not-fit-beside-show';

test.skipIf(!hasDom)('the line never wraps: only the project name shrinks, cut with an ellipsis; the count and Show keep their size', () => {
  const el = render({ count: 1, project: LONG });
  const button = el.querySelector<HTMLElement>('[data-inbox-notice]')!;
  const project = button.querySelector<HTMLElement>('.ib-notice-proj')!;
  const count = button.querySelector<HTMLElement>('.ib-notice-n')!;
  const show = button.querySelector<HTMLElement>('b')!;
  expect(button.textContent).toBe(`1 new in ${LONG}Show`);
  expect(project.textContent).toBe(LONG);
  expect(getComputedStyle(button).whiteSpace).toBe('nowrap');
  expect(getComputedStyle(project).textOverflow).toBe('ellipsis');
  expect(getComputedStyle(project).overflow).toBe('hidden');
  expect(getComputedStyle(project).minWidth).toBe('0');
  expect(getComputedStyle(count).flexShrink).toBe('0');
  expect(getComputedStyle(show).flexShrink).toBe('0');
});

test.skipIf(!hasDom)('a cut project name puts the whole line in a tooltip; a name that fits shows none', async () => {
  const el = render({ count: 1, project: LONG });
  const button = el.querySelector<HTMLElement>('[data-inbox-notice]')!;
  const project = button.querySelector<HTMLElement>('.ib-notice-proj')!;
  expect(button.hasAttribute('title')).toBe(false);
  sized(project, 420, 120);
  hover(button);
  await wait(400);
  expect(tooltipWith(el, `1 new in ${LONG}`)).toBe(true);
  act(() => root?.unmount());
  host?.remove();

  const fits = render({ count: 1, project: 'appnotes' });
  const fitting = fits.querySelector<HTMLElement>('[data-inbox-notice]')!;
  sized(fitting.querySelector<HTMLElement>('.ib-notice-proj')!, 60, 60);
  hover(fitting);
  await wait(400);
  expect(tooltipWith(fits, '1 new in appnotes')).toBe(false);
});

test.skipIf(!hasDom)('news across projects reads just "N new"', () => {
  for (const notice of [{ count: 3 }, { count: 1, project: null }]) {
    const el = render(notice);
    const button = el.querySelector<HTMLElement>('[data-inbox-notice]')!;
    expect(button.querySelector('.ib-notice-proj')).toBeNull();
    expect(button.textContent).toBe(`${notice.count} new` + 'Show');
    act(() => root?.unmount());
    host?.remove();
    sheet?.remove();
  }
  expect(render(null).querySelector('[data-inbox-notice]')).toBeNull();
});
