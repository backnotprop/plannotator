import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProjectRepo } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : { MessageBody: null }) as typeof import('./components/Thread');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function message(body: string, author: InboxMessageWire['author']): InboxMessageWire {
  return {
    id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    thread_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    project_id: 'prj_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    author,
    body,
    attachments: [],
    questions: [],
  } as unknown as InboxMessageWire;
}

const AGENT = { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' } as const;

async function render(body: string, repo: InboxProjectRepo | null | undefined, author: InboxMessageWire['author'] = AGENT, extra: { contextNotes?: object } = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody
        message={message(body, author)}
        projectRoot="/work/widgets"
        repo={repo}
        onOpenAttachment={() => {}}
        readOnly
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
        {...extra}
      />,
    );
  });
}

test.skipIf(!hasDom)("an agent's #123 links to the issue in the project's GitHub repository, in a new tab", async () => {
  await render('This fixes #123, see also #45.', { display: 'acme/widgets', host: 'github.com' });
  const link = [...host!.querySelectorAll<HTMLAnchorElement>('a')].find((a) => a.textContent === '#123')!;
  expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets/issues/123');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(host!.querySelector('a[href="https://github.com/acme/widgets/issues/45"]')).not.toBeNull();
  expect(host!.textContent).not.toContain('acme/widgets');
});

test.skipIf(!hasDom)("a person's reply links too, and a GitLab remote links to its -/issues path", async () => {
  await render('Done in #9.', { display: 'group/sub/platform', host: 'gitlab.example.com' }, { kind: 'person' });
  expect(host!.querySelector('a[href="https://gitlab.example.com/group/sub/platform/-/issues/9"]')).not.toBeNull();
});

test.skipIf(!hasDom)('without a repo (a folder, or an older Inbox) the ref stays unlinked', async () => {
  for (const repo of [null, undefined]) {
    await render('This fixes #123.', repo);
    expect(host!.querySelector('a')).toBeNull();
    expect(host!.textContent).toContain('#123');
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  }
});

test.skipIf(!hasDom)("with the Inbox's own configuration, a digit-only #186379 is an issue link, not a colour swatch (#1932)", async () => {
  await import('./App');
  await render('Merged in #186379.', { display: 'home-assistant/core', host: 'github.com' });
  expect(host!.querySelector('a[href="https://github.com/home-assistant/core/issues/186379"]')).not.toBeNull();
  expect(host!.querySelector('[style*="background-color"]')).toBeNull();
});

test.skipIf(!hasDom)("with the Inbox's own configuration, owner/repo#N links on github.com in a project with no repo; #N stays plain", async () => {
  await import('./App');
  for (const repo of [null, undefined]) {
    await render('The crash fix (backnotprop/plannotator#2948) is merged, and #12 too.', repo);
    const links = [...host!.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')])).toEqual([
      ['backnotprop/plannotator#2948', 'https://github.com/backnotprop/plannotator/issues/2948', '_blank'],
    ]);
    expect(host!.textContent).toContain('#12');
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  }
});

test.skipIf(!hasDom)("with the Inbox's own configuration, a GitLab project's refs stay on its host, in the text and in a context note", async () => {
  await import('./App');
  const repo = { display: 'team/app', host: 'gitlab.example.com' };
  await render('See group/project#7.\n\n:::note src/app.ts#L3\nSee group/project#8.\n:::', repo, AGENT, { contextNotes: {} });
  expect(host!.querySelector('a[href="https://gitlab.example.com/group/project/-/issues/7"]')).not.toBeNull();
  const note = host!.querySelector('[data-context-note-block]')!;
  expect(note.querySelector('a')?.getAttribute('href')).toBe('https://gitlab.example.com/group/project/-/issues/8');
  expect(host!.querySelector('a[href^="https://github.com"]')).toBeNull();
});

test.skipIf(!hasDom)('in a repoless thread of a mostly-GitLab Inbox, owner/repo#N links on GitLab, and an open message follows a change', async () => {
  await import('./App');
  const { learnDefaultRefHost, resetDefaultRefHost } = await import('./defaultRefHost');
  try {
    learnDefaultRefHost([{ repo_host: 'gitlab.example.com' }, { repo_host: 'gitlab.example.com' }, { repo_host: 'github.com' }, {}]);
    await render('See group/project#7 and #3.', null);
    expect([...host!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://gitlab.example.com/group/project/-/issues/7']);
    act(() => learnDefaultRefHost([{ repo_host: 'gitlab.example.com' }, { repo_host: 'github.com' }]));
    expect([...host!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://github.com/group/project/issues/7']);
  } finally {
    resetDefaultRefHost();
  }
});
