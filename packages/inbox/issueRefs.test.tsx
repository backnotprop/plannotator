/**
 * Bare `#123` refs in a message (#1840): with the project's `origin` from the
 * thread payload they link to that repository's issue on its forge, in a new
 * tab with no opener, and no repo badge is drawn on the message; without one
 * they stay the styled span they were.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire, InboxProjectRepo } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
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
  // Links only: the repo badge `repoInfo` would draw is not on the message.
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
  // App.tsx configures ui at import (digitHexIssueRefs: true); dropping the flag there fails this.
  await import('./App');
  await render('Merged in #186379.', { display: 'home-assistant/core', host: 'github.com' });
  expect(host!.querySelector('a[href="https://github.com/home-assistant/core/issues/186379"]')).not.toBeNull();
  expect(host!.querySelector('[style*="background-color"]')).toBeNull();
});

test.skipIf(!hasDom)("with the Inbox's own configuration, owner/repo#N links on github.com in a project with no repo; #N stays plain", async () => {
  // App.tsx turns on crossRepoRefsWithoutRepo: agents are told to write owner/repo#N for another repo's PR.
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
    // A later list read where github.com ties: the message already on screen re-renders on github.com.
    act(() => learnDefaultRefHost([{ repo_host: 'gitlab.example.com' }, { repo_host: 'github.com' }]));
    expect([...host!.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://github.com/group/project/issues/7']);
  } finally {
    resetDefaultRefHost();
  }
});

test.skipIf(!hasDom)('in a repoless thread of a mostly-GitLab Inbox, !N and group/project!N stay plain: they need a real GitLab project', async () => {
  await import('./App');
  const { learnDefaultRefHost, resetDefaultRefHost } = await import('./defaultRefHost');
  try {
    learnDefaultRefHost([{ repo_host: 'gitlab.example.com' }, { repo_host: 'gitlab.example.com' }, { repo_host: 'github.com' }]);
    await render('Merged !12, group/project!45 and group/sub/project!46; issue group/project#7.', null);
    expect([...host!.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['group/project#7', 'https://gitlab.example.com/group/project/-/issues/7'],
    ]);
    expect(host!.textContent).toContain('Merged !12, group/project!45 and group/sub/project!46;');
  } finally {
    resetDefaultRefHost();
  }
});

const hrefsByText = () => [...host!.querySelectorAll<HTMLAnchorElement>('a')].map((a) => [a.textContent, a.getAttribute('href')]);

test.skipIf(!hasDom)("a GitLab project's !N and group/sub/project!N link to merge requests on its own host; look-alikes stay plain", async () => {
  await import('./App');
  const repo = { display: 'harbor-group/harbor', host: 'gitlab.harbor.dev' };
  const body = [
    'Merged !123, then harbor-group/harbor!45 and harbor-group/infra/fern-api!6 (and !12). Issue #7, also !13.',
    '',
    'Plain: `!9` and `harbor-group/harbor!10`, wow!123abc, x!14, !important, !15abc, \\!16, see https://gitlab.harbor.dev/a/b!17 too, ![!20](shot!21.png) and [label !22](https://example.com/x).',
    '',
    '```',
    'echo !18 harbor-group/harbor!19',
    '```',
  ].join('\n');
  await render(body, repo);
  const MR = 'https://gitlab.harbor.dev/harbor-group/harbor/-/merge_requests';
  expect(hrefsByText()).toEqual([
    ['!123', `${MR}/123`],
    ['harbor-group/harbor!45', `${MR}/45`],
    ['harbor-group/infra/fern-api!6', 'https://gitlab.harbor.dev/harbor-group/infra/fern-api/-/merge_requests/6'],
    ['!12', `${MR}/12`],
    ['#7', 'https://gitlab.harbor.dev/harbor-group/harbor/-/issues/7'],
    ['!13', `${MR}/13`],
    ['https://gitlab.harbor.dev/a/b!17', 'https://gitlab.harbor.dev/a/b!17'],
    ['label !22', 'https://example.com/x'],
  ]);
  expect(host!.textContent).toContain('wow!123abc');
  expect(host!.textContent).toContain('!important');
  expect(host!.textContent).toContain('!16');
  // A click opens the merge request's card, as a #N's does.
  for (const a of host!.querySelectorAll('a[href*="/-/merge_requests/"]')) expect(a.hasAttribute('data-ref-card-prose')).toBe(true);
});

test.skipIf(!hasDom)('the same words in a GitHub project link only the #N: !N and group/project!N stay plain text', async () => {
  await import('./App');
  await render('Merged !123, then harbor-group/harbor!45 and harbor-group/infra/fern-api!6. Issue #7.', { display: 'fern/fern-api', host: 'github.com' });
  expect(hrefsByText()).toEqual([['#7', 'https://github.com/fern/fern-api/issues/7']]);
  expect(host!.textContent).toContain('Merged !123, then harbor-group/harbor!45 and harbor-group/infra/fern-api!6.');
});
