/**
 * A sidebar project with nothing waiting is drawn quiet (muted text). It used
 * to carry the class `ib-q`, which the question card also uses (#1838), so a
 * quiet project rendered as a bordered card with 20px margins in the sidebar.
 * The failure this catches is the folder sharing a class with any question
 * card style again: it must not match `.pn-inbox .ib-q`.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

test.skipIf(!hasDom)('a quiet project folder is not styled as a question card', () => {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const project = { id: 'prj_q', key: 'quiet-abc123', name: 'quiet', root: '/tmp/quiet', created_at: '2026-10-11T10:00:00.000Z', threads: 1, unread: 0 };
  const busy = { ...project, id: 'prj_b', key: 'busy-abc123', name: 'busy', root: '/tmp/busy' };
  root = createRoot(host);
  const noop = () => {};
  act(() =>
    root!.render(
      <SidebarProvider>
        <Sidebar
          page="inbox"
          projectId={null}
          inboxCount={1}
          projects={[project, busy] as never}
          projectCounts={new Map([['prj_b', 1]])}
          update={null}
          restarting={false}
          updated={null}
          onInbox={noop}
          onProject={noop}
          onSettings={noop}
          onUpdate={noop}
          onWhatsNew={noop}
        />
      </SidebarProvider>,
    ),
  );
  const folders = [...host.querySelectorAll<HTMLButtonElement>('.ib-proj')];
  const quiet = folders.find((b) => b.textContent?.includes('quiet'))!;
  const busyFolder = folders.find((b) => b.textContent?.includes('busy'))!;
  expect(quiet.matches('.pn-inbox .ib-q')).toBe(false);
  expect(quiet.classList.contains('ib-proj-quiet')).toBe(true);
  expect(busyFolder.classList.contains('ib-proj-quiet')).toBe(false);
});
