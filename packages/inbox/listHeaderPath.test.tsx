/**
 * A project's list header shows its name alone; the folder is in the title's
 * tooltip (owner, 2026-10-29: the path beside the name was noise and cut off its end).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const PATH = '~/workspaces/projects/appnotes/worktrees/main';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  root = null;
  host = null;
});

test.skipIf(!hasDom)("a project's list header draws no path; its folder is in the title's tooltip", async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="appnotes" path={PATH} sections={[]} filtered narrow={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} phone={false} />
        </div>
      </SidebarProvider>,
    );
  });
  const head = host.querySelector<HTMLElement>('.ib-lhead')!;
  expect(head.textContent).toContain('appnotes');
  expect(head.textContent).not.toContain('workspaces');
  expect(head.querySelector('.ib-path')).toBeNull();

  const title = head.querySelector<HTMLElement>('h1')!;
  await act(async () => {
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      title.dispatchEvent(new Ctor(type, { bubbles: type !== 'pointerenter' && type !== 'mouseenter', cancelable: true, pointerType: 'mouse', clientX: 10, clientY: 10 } as PointerEventInit));
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  const tip = [...document.body.querySelectorAll('[data-project-tip]')].find((n) => !host!.contains(n));
  expect(tip?.textContent).toContain(PATH);
});
