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

async function render(body: string, repo: InboxProjectRepo | null | undefined, author: InboxMessageWire['author'] = AGENT) {
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
        recordingOf={() => undefined}
        onToggleDecision={() => {}}
        onOpenDecision={() => {}}
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
