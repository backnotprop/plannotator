/**
 * Links in a message to the files it attached (links.ts): a link to one of
 * THAT message's attachments opens it beside the thread, a link to any other
 * local path is inert text that never reaches the server, and an external
 * link keeps opening in a new tab.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachment, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentDeepLink, attachmentDisplayPath, attachmentForLink, normalizeLinkPath } from './links';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { MessageBody } = (hasDom ? await import('./components/Thread') : { MessageBody: null }) as typeof import('./components/Thread');
const Viewer = (hasDom ? (await import('@plannotator/ui/components/Viewer')).Viewer : null) as typeof import('@plannotator/ui/components/Viewer')['Viewer'];
const { parseMarkdownToBlocks } = await import('@plannotator/ui/utils/parser');

const ROOT = '/work/app';

function attachment(id: string, path: string, extra: Partial<InboxAttachment> = {}): InboxAttachment {
  return {
    id,
    path,
    named_path: null,
    name: path.slice(path.lastIndexOf('/') + 1),
    kind: path.endsWith('.html') ? 'html' : 'markdown',
    sent_sha256: 'a'.repeat(64),
    size: 10,
    sent_at: '2026-10-10T10:00:00.000Z',
    sent_mtime: '2026-10-10T10:00:00.000Z',
    ...extra,
  };
}

const MOCK = attachment('att_mock', `${ROOT}/design/mock.html`);
const PLAN = attachment('att_plan', `${ROOT}/docs/plan.md`, { named_path: `${ROOT}/docs/current-plan.md` });

test('a link matches an attachment by its path from the sender folder or the project root', () => {
  const options = { attachments: [MOCK, PLAN], root: ROOT, base: `${ROOT}/design` };
  expect(attachmentForLink('mock.html', options)?.id).toBe('att_mock');
  expect(attachmentForLink('./mock.html#top', options)?.id).toBe('att_mock');
  expect(attachmentForLink('design/mock.html?x=1', options)?.id).toBe('att_mock');
  expect(attachmentForLink('../docs/plan.md', options)?.id).toBe('att_plan');
  expect(attachmentForLink(`${ROOT}/design/mock.html`, options)?.id).toBe('att_mock');
  // The path the agent named, for a symlink.
  expect(attachmentForLink('docs/current-plan.md', options)?.id).toBe('att_plan');
  // A bare file name: the one attachment with that name.
  expect(attachmentForLink('plan.md', options)?.id).toBe('att_plan');
  // Not attached: another file, a name in another folder, a path out of the project.
  expect(attachmentForLink('notes.md', options)).toBeNull();
  expect(attachmentForLink('other/mock.html', options)).toBeNull();
  expect(attachmentForLink('../../../etc/passwd', options)).toBeNull();
});

test('a percent-encoded link and a Windows path still match', () => {
  const spaced = attachment('att_sp', `${ROOT}/my mock.html`);
  expect(attachmentForLink('my%20mock.html', { attachments: [spaced], root: ROOT })?.id).toBe('att_sp');
  const win = attachment('att_win', 'C:\\work\\app\\mock.html');
  expect(attachmentForLink('mock.html', { attachments: [win], root: 'C:\\work\\app' })?.id).toBe('att_win');
  expect(normalizeLinkPath('C:\\a\\b\\..\\c')).toBe('c:/a/c');
});

test("an attachment's display path is relative to the project, its deep link the window's own route", () => {
  expect(attachmentDisplayPath(MOCK, ROOT)).toBe('design/mock.html');
  expect(attachmentDisplayPath(PLAN, `${ROOT}/`)).toBe('docs/current-plan.md');
  expect(attachmentDisplayPath(attachment('att_out', '/elsewhere/x.md'), ROOT)).toBe('/elsewhere/x.md');
  const link = attachmentDeepLink('msg_1', 'att_2');
  expect(link).toBe('#thread=msg_1&file=att_2');
  // App.tsx reads the route from the hash with URLSearchParams.
  const params = new URLSearchParams(link.slice(1));
  expect([params.get('thread'), params.get('file')]).toEqual(['msg_1', 'att_2']);
});

test('two attachments with one name: a bare name picks neither', () => {
  const a = attachment('att_a', `${ROOT}/a/mock.html`);
  const b = attachment('att_b', `${ROOT}/b/mock.html`);
  expect(attachmentForLink('mock.html', { attachments: [a, b], root: ROOT })).toBeNull();
  expect(attachmentForLink('b/mock.html', { attachments: [a, b], root: ROOT })?.id).toBe('att_b');
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function message(body: string, attachments: InboxAttachment[]): InboxMessageWire {
  return {
    id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    thread_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    project_id: 'prj_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' },
    body,
    attachments,
    questions: [],
  } as unknown as InboxMessageWire;
}

async function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

test.skipIf(!hasDom)('in a message, an attached file opens beside the thread; an unattached one is inert; an external link is unchanged', async () => {
  const opened: string[] = [];
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetched.push(String(input));
    return Promise.resolve(new Response('{}'));
  }) as typeof fetch;
  try {
    const body = [
      ':::question',
      'Which layout should the settings page use?',
      '',
      'The two-column one keeps the preview visible. See [the mock](mock.html).',
      '',
      '- [ ] Two columns',
      '- [ ] One column',
      ':::',
      '',
      'Also [my notes](notes.md) and [the docs](https://example.com/docs).',
      '',
      '<p><a href="mock.html">raw mock</a> and <a href="secret.md">raw other</a></p>',
    ].join('\n');
    await mount(
      <MessageBody
        message={message(body, [MOCK])}
        projectRoot={ROOT}
        onOpenAttachment={(a) => opened.push(a.id)}
        readOnly={false}
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
        recordingOf={() => undefined}
        onToggleDecision={() => {}}
        onOpenDecision={() => {}}
      />,
    );

    // The link inside the question's context is a real, focusable link that opens the pane.
    const mock = [...host!.querySelectorAll<HTMLAnchorElement>('a[data-local-link="open"]')].find((a) => a.textContent?.includes('the mock'))!;
    expect(mock).toBeDefined();
    // Its href is the window's own deep link to the file, so a new tab opens it there.
    expect(mock.getAttribute('href')).toBe('#thread=msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ&file=att_mock');
    // The tooltip names the file by its path in the project, not its bare name.
    expect(mock.getAttribute('title')).toBe('Open design/mock.html beside the thread');
    await act(async () => mock.click());
    expect(opened).toEqual(['att_mock']);

    // A raw-HTML link to the same attachment opens it too.
    const rawMock = [...host!.querySelectorAll<HTMLAnchorElement>('a[data-local-link="open"]')].find((a) => a.textContent === 'raw mock')!;
    expect(rawMock.getAttribute('href')).toBe('#thread=msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ&file=att_mock');
    await act(async () => rawMock.click());
    expect(opened).toEqual(['att_mock', 'att_mock']);

    // A Cmd/Ctrl click is the browser's (a new tab at the deep link), never the pane.
    for (const link of [mock, rawMock]) {
      const modified = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
      await act(async () => {
        link.dispatchEvent(modified);
      });
      expect(modified.defaultPrevented).toBe(false);
    }
    expect(opened).toEqual(['att_mock', 'att_mock']);

    // Not attached: no href anywhere, so a click goes nowhere and nothing is fetched.
    const notes = host!.querySelector<HTMLElement>('[data-local-link="unavailable"]')!;
    expect(notes.textContent).toBe('my notes');
    expect(notes.tagName).toBe('SPAN');
    expect(notes.getAttribute('title')).toContain('Not attached');
    const rawOther = [...host!.querySelectorAll<HTMLElement>('[data-local-link="unavailable"]')].find((el) => el.textContent === 'raw other')!;
    expect(rawOther.hasAttribute('href')).toBe(false);
    await act(async () => {
      notes.click();
      rawOther.click();
    });
    expect(opened).toEqual(['att_mock', 'att_mock']);
    expect(host!.querySelector('a[href="notes.md"], a[href="secret.md"]')).toBeNull();
    expect(fetched.filter((url) => url.includes('notes.md') || url.includes('secret.md'))).toEqual([]);

    // External: a new tab, no opener, as before.
    const external = host!.querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]')!;
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
    expect(external.hasAttribute('data-local-link')).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test.skipIf(!hasDom)('a Viewer without resolveLocalLink draws a local link as it always has', async () => {
  const body = 'See [the mock](mock.html) and [notes](notes.md).';
  await mount(
    <Viewer
      blocks={parseMarkdownToBlocks(body, { frontmatter: false })}
      markdown={body}
      annotations={[]}
      onAddAnnotation={() => {}}
      onSelectAnnotation={() => {}}
      selectedAnnotationId={null}
      mode="selection"
      taterMode={false}
      maxWidth={null}
      stickyActions={false}
      disableCodePathValidation
      readOnly
    />,
  );
  expect(host!.querySelector('[data-local-link]')).toBeNull();
  expect(host!.querySelector('a[href="mock.html"]')).not.toBeNull();
  expect(host!.querySelector('a[href="notes.md"]')).not.toBeNull();
});
