/**
 * A row names its project by its folder (owner's pick, 2026-10-29), adding
 * the parent only when two projects with rows in the list share it. The
 * server's name ("plannotator · plannotator", lengthened by a stored project
 * the list does not show) is what agents read; the row does not show it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { windowProjectNames } = await import('./projectLabels');

const AGENT = { kind: 'agent' as const, host: 'claude-code', session: 'ses_a', name: null };

const PROJECTS = [
  { id: 'prj_repo', root: '/Users/me/plannotator/plannotator', name: 'plannotator · plannotator' },
  // Stored, no row in the list: the clash the server's name carries.
  { id: 'prj_old_wt', root: '/Users/me/old/plannotator', name: 'plannotator · old' },
  { id: 'prj_api_w', root: '/work/api', name: 'api · work' },
  { id: 'prj_api_h', root: '/personal/api', name: 'api · personal' },
];

function row(id: string, project: (typeof PROJECTS)[number]): InboxListRow {
  return {
    thread_id: id,
    project_id: project.id,
    subject: `Subject ${id}`,
    author: AGENT,
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: project.id, name: project.name },
    thread_name: null,
    section: 'waiting',
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  };
}

const SECTIONS: InboxListSection[] = [
  { id: 'waiting', label: 'Waiting on you', threads: [row('msg_repo', PROJECTS[0]!), row('msg_w', PROJECTS[2]!)] },
  // A folded Quiet row counts as listed: opening Quiet does not rename the rows above.
  { id: 'quiet', label: 'Quiet', threads: [row('msg_h', PROJECTS[3]!)] },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function draw(shape: 'wide' | 'narrow' | 'phone', sections: InboxListSection[]) {
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList
            title="Inbox"
            path={null}
            sections={sections}
            filtered={false}
            projectNames={windowProjectNames({ projects: PROJECTS, sidebar: [], sections })}
            narrow={shape === 'narrow'}
            selectedThreadId={null}
            notice={null}
            onShowNew={() => {}}
            onOpen={() => {}}
            phone={shape === 'phone'}
          />
        </div>
      </SidebarProvider>,
    );
  });
}

function render(shape: 'wide' | 'narrow' | 'phone', sections: InboxListSection[] = SECTIONS): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  draw(shape, sections);
  return host!;
}

const projectOf = (el: HTMLElement, id: string) => el.querySelector(`[data-thread-id="${id}"] .ib-p`)?.textContent;

test.skipIf(!hasDom)('a row reads its folder name unless another listed project shares it, in every row shape', () => {
  for (const shape of ['wide', 'narrow', 'phone'] as const) {
    const el = render(shape);
    // The only clash is with a project that has no row: the folder name alone.
    expect(projectOf(el, 'msg_repo')).toBe('plannotator');
    // "api" twice in the list (one row in the folded Quiet): each adds its parent.
    expect(projectOf(el, 'msg_w')).toBe('api · work');
    act(() => root?.unmount());
    host?.remove();
  }
});

// ListRow is memoized on its row's content: a row whose data did not change must still draw the name the
// list now gives its project, when another project's row lands and makes the name clash.
test.skipIf(!hasDom)('a row already drawn adds its parent once a row from another project with its name lands', () => {
  for (const shape of ['wide', 'narrow', 'phone'] as const) {
    const repo = row('msg_repo', PROJECTS[0]!);
    const el = render(shape, [{ id: 'waiting', label: 'Waiting on you', threads: [repo] }]);
    expect(projectOf(el, 'msg_repo')).toBe('plannotator');
    // The same row data (a fresh object, as each list read brings), and the old worktree's thread arriving.
    draw(shape, [{ id: 'waiting', label: 'Waiting on you', threads: [{ ...repo }, row('msg_wt', PROJECTS[1]!)] }]);
    expect(projectOf(el, 'msg_repo')).toBe('plannotator · plannotator');
    expect(projectOf(el, 'msg_wt')).toBe('plannotator · old');
    act(() => root?.unmount());
    host?.remove();
  }
});
