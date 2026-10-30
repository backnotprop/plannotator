/**
 * The files named in the person's own sent reply, as links
 * (replyFileLinks.ts): each "## <file>" heading the Send's feedback text
 * wrote opens THAT file of the thread at the version its comments were on; a
 * drawing's name shows the drawing; a heading whose file the thread no longer
 * has stays text. The feedback is built by the real export
 * (`attachmentFeedback`), so a change to its headings that the links no
 * longer read fails here.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentFeedback, codeCommentAnnotation, imageCommentAnnotation, videoCommentAnnotation } from './attachments';
import { linkReplyFeedback, replyFeedbackFile, resolveReplyLink, type ReplyFileContext } from './replyFileLinks';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : { MessageBody: null }) as typeof import('./components/Thread');

const ROOT = '/work/shop';
const AGENT_MSG = 'msg_01K7AGENT00000000000000000';
const MY_MSG = 'msg_01K7MINE000000000000000000';
const REPLY = 'msg_01K7REPLY00000000000000000';
const SHA = 'a'.repeat(64);
const MARKUP = `/home/me/.plannotator/inbox/markups/${'b'.repeat(64)}.png`;

function file(id: string, path: string, kind: string, extra: Partial<InboxAttachmentState> = {}): InboxAttachmentState {
  return {
    id,
    path: `${ROOT}/${path}`,
    named_path: null,
    name: path.slice(path.lastIndexOf('/') + 1),
    kind,
    sent_sha256: SHA,
    size: 10,
    sent_at: '2026-10-29T18:00:00.000Z',
    sent_mtime: '2026-10-29T18:00:00.000Z',
    message_id: AGENT_MSG,
    current: { sha256: SHA, size: 10, mtime: '2026-10-29T18:00:00.000Z' },
    changed_since_sent: false,
    unavailable: null,
    ...extra,
  } as InboxAttachmentState;
}

const IMAGE = file('att_image', 'design/checkout.png', 'image');
const CODE = file('att_code', 'src/retry.ts', 'code');
const DOC = file('att_doc', 'docs/plan.md', 'markdown');
const PAGE = file('att_page', 'proto/admin.html', 'html');
const FILM = file('att_film', 'media/walkthrough.mp4', 'video', { duration_ms: 461_000 } as Partial<InboxAttachmentState>);
/** An image the agent's text showed, captured as a file of the thread. */
const HERO = file('att_hero', 'design/hero.png', 'image', { ref: 'design/hero.png' });
/** An image the person's own message showed. */
const MINE = file('att_mine', 'shots/before.png', 'image', { ref: 'shots/before.png', message_id: MY_MSG, sent_at: '2026-10-29T18:05:00.000Z' });
const FILES = [IMAGE, CODE, DOC, PAGE, FILM, HERO, MINE];

function record(target: InboxAttachmentState, annotation: object, version = 'current'): InboxAnnotationRecord {
  return {
    id: (annotation as { id: string }).id,
    project_id: 'prj_1',
    thread_id: AGENT_MSG,
    message_id: target.message_id,
    attachment_id: target.id,
    path: target.path,
    version,
    annotation: annotation as Record<string, unknown>,
    created_at: '2026-10-29T18:10:00.000Z',
    updated_at: '2026-10-29T18:10:00.000Z',
    removed_at: null,
    sent_reply_id: null,
  };
}

const RECORDS = [
  record(IMAGE, imageCommentAnnotation({ id: 'a1', name: 'checkout.png', text: 'More weight on the total.', markup: { path: MARKUP, name: 'checkout markup' } })),
  record(CODE, codeCommentAnnotation({ id: 'a2', lineStart: 3, lineEnd: 3, text: 'Do not swallow errors.', code: 'catch {}' })),
  record(DOC, { id: 'a3', type: 'COMMENT', text: 'Say it once.', originalText: 'billed yearly', blockId: 'block-1', startOffset: 0, endOffset: 0, createdA: 1 }),
  record(PAGE, { id: 'a4', type: 'COMMENT', text: 'Ask first.', originalText: 'Retry all', blockId: 'block-0', startOffset: 0, endOffset: 0, createdA: 2 }),
  record(FILM, videoCommentAnnotation({ id: 'a5', name: 'walkthrough.mp4', time: 4.2, text: 'Cut the pause.' })),
  record(HERO, imageCommentAnnotation({ id: 'a6', name: 'hero.png', text: 'Softer gradient.' })),
  // On the version the person's own message sent, not the file as it is now.
  record(MINE, imageCommentAnnotation({ id: 'a7', name: 'before.png', text: 'This is the old one.' }), SHA),
];

const PEOPLE = new Set([MY_MSG, REPLY]);
const context = (files: readonly InboxAttachmentState[] = FILES): ReplyFileContext => ({ files, projectRoot: ROOT, personMessageIds: PEOPLE, replyAt: '2026-10-29T18:20:00.000Z' });
const feedback = () => attachmentFeedback(RECORDS, FILES, new Map(), ROOT, { personMessageIds: PEOPLE });

/** Each heading's link target in the linked text: `label → token`. */
function headingLinks(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of markdown.matchAll(/^## \[(.+)\]\((\.inbox-reply\/[^)]+)\)$/gm)) out[match[1]!] = match[2]!;
  return out;
}

test('every file heading the export wrote links to that file of the thread, at the version its comments were on', () => {
  const text = feedback();
  const links = headingLinks(linkReplyFeedback(`Notes below.\n\n${text}`, context()));
  const hero = Object.keys(links).find((label) => label.startsWith('design/hero.png (image in your '))!;
  const mine = Object.keys(links).find((label) => label.startsWith('shots/before.png (image in my '))!;
  expect(links).toEqual({
    'design/checkout.png': '.inbox-reply/file/att_image/current',
    'src/retry.ts': '.inbox-reply/file/att_code/current',
    'docs/plan.md': '.inbox-reply/file/att_doc/current',
    'proto/admin.html': '.inbox-reply/file/att_page/current',
    'media/walkthrough.mp4': '.inbox-reply/file/att_film/current',
    [hero]: '.inbox-reply/file/att_hero/current',
    // "(the version I sent)": the sent version, not the file as it is now.
    [mine]: '.inbox-reply/file/att_mine/sent',
  });
  expect(mine.endsWith('(the version I sent)')).toBe(true);
  // Nothing else of the text changes: the words, the comments, the drawing's path.
  const plain = linkReplyFeedback(`Notes below.\n\n${text}`, context()).replace(/^## \[(.+)\]\(\.inbox-reply\/[^)]+\)$/gm, '## $1').replace(/\[(checkout markup)\]\(\.inbox-reply\/markup\/[^)]+\)/, `[$1] \`${MARKUP}\``);
  expect(plain).toBe(`Notes below.\n\n${text}`);
});

test('a drawing on an image links to the drawing; the resolver opens files and drawings only', () => {
  const linked = linkReplyFeedback(feedback(), context());
  const line = linked.split('\n').find((l) => l.includes('checkout markup'))!;
  // The link shows the drawing: its data-dir path is not drawn after it (the stored text keeps it).
  expect(line).toBe(`- [checkout markup](.inbox-reply/markup/${'b'.repeat(64)}.png)`);
  expect(resolveReplyLink(`.inbox-reply/markup/${'b'.repeat(64)}.png`, FILES)).toEqual({ kind: 'markup', src: `/api/inbox/markups/${'b'.repeat(64)}.png` });
  // A path that is not a drawing the Inbox kept stays as written.
  const other = '**Attached images:**\n- [shot] `/tmp/shot.png`';
  expect(linkReplyFeedback(`# Feedback on the attached files\n\n## design/checkout.png\n\n${other}\n\n---`, context())).toContain(other);
  expect(resolveReplyLink('.inbox-reply/markup/../../secret.png', FILES)).toBeNull();
  expect(resolveReplyLink('.inbox-reply/file/att_image/sent', FILES)).toEqual({ kind: 'file', attachment: IMAGE, version: 'sent' });
  expect(resolveReplyLink('docs/plan.md', FILES)).toBeNull();
});

test('a file the thread no longer has stays plain text; one that moved opens the version sent', () => {
  const text = feedback();
  // The attachment is gone from the thread: no link, and a link written earlier resolves to nothing.
  const without = headingLinks(linkReplyFeedback(text, context(FILES.filter((f) => f.id !== 'att_doc'))));
  expect(without['docs/plan.md']).toBeUndefined();
  expect(Object.keys(without)).toContain('src/retry.ts');
  expect(resolveReplyLink('.inbox-reply/file/att_doc/current', FILES.filter((f) => f.id !== 'att_doc'))).toBeNull();
  // Moved or deleted on disk: the current file cannot be opened, the version sent always can.
  const moved = FILES.map((f) => (f.id === 'att_code' ? { ...f, current: null, unavailable: { code: 'attachment_missing' as const, message: 'gone' } } : f));
  expect(headingLinks(linkReplyFeedback(text, context(moved)))['src/retry.ts']).toBe('.inbox-reply/file/att_code/sent');
});

test('the same file attached twice: the heading opens the one sent before the reply', () => {
  const later = { ...CODE, id: 'att_code_later', sent_at: '2026-10-29T19:00:00.000Z' };
  const earlier = { ...CODE, id: 'att_code_again', sent_at: '2026-10-29T18:15:00.000Z' };
  expect(replyFeedbackFile('src/retry.ts', context([CODE, earlier, later]))?.attachment.id).toBe('att_code_again');
});

test('an image in a message whose time reads differently now is still found by its src, in a message of the right owner', () => {
  expect(replyFeedbackFile('design/hero.png (image in your 3:04 AM message)', context())?.attachment.id).toBe('att_hero');
  expect(replyFeedbackFile('design/nowhere.png (image in your 3:04 AM message)', context())).toBeNull();
  // "my": only the person's own messages; "your": only an agent's.
  expect(replyFeedbackFile('shots/before.png (image in my 3:04 AM message)', context())?.attachment.id).toBe('att_mine');
  expect(replyFeedbackFile('design/hero.png (image in my 3:04 AM message)', context())).toBeNull();
  expect(replyFeedbackFile('shots/before.png (image in your 3:04 AM message)', context())).toBeNull();
});

test('only the attached-files section is read, never a fence, and a label the link cannot hold stays text', () => {
  const body = [
    'My words.',
    '',
    '## src/retry.ts',
    '',
    '# Feedback on the attached files',
    '',
    '```',
    '## docs/plan.md',
    '```',
    '',
    '## odd]name.ts',
    '',
    '## docs/plan.md',
    '',
    '---',
    '',
    '# Feedback on the guided review',
    '',
    '## src/retry.ts',
  ].join('\n');
  const out = linkReplyFeedback(body, context()).split('\n');
  expect(out[2]).toBe('## src/retry.ts');
  expect(out[7]).toBe('## docs/plan.md');
  expect(out[10]).toBe('## odd]name.ts');
  expect(out[12]).toBe('## [docs/plan.md](.inbox-reply/file/att_doc/current)');
  expect(out[18]).toBe('## src/retry.ts');
  // No feedback section: the text is returned as it is.
  expect(linkReplyFeedback('## docs/plan.md', context())).toBe('## docs/plan.md');
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  for (const el of document.querySelectorAll('body > *')) el.remove();
  root = null;
  host = null;
});

function reply(body: string): InboxMessageWire {
  return {
    id: REPLY,
    thread_id: AGENT_MSG,
    project_id: 'prj_1',
    author: { kind: 'person' },
    body,
    created_at: '2026-10-29T18:20:00.000Z',
    attachments: [],
    questions: [],
  } as unknown as InboxMessageWire;
}

test.skipIf(!hasDom)("in the person's sent reply, a file heading opens the file beside the thread and a drawing shows the drawing", async () => {
  const opened: string[] = [];
  const files = FILES.filter((f) => f.id !== 'att_page');
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody
        message={reply(`Notes on the files below.\n\n${feedback()}`)}
        projectRoot={ROOT}
        onOpenAttachment={() => opened.push('message link')}
        readOnly
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
        replyFiles={{ files, personMessageIds: PEOPLE, onOpen: (attachment, version) => opened.push(`${attachment.id}@${version}`) }}
      />,
    );
  });
  const heading = (name: string) => [...host!.querySelectorAll('h2')].find((h) => h.textContent?.startsWith(name))!;
  const link = heading('design/checkout.png').querySelector<HTMLAnchorElement>('a[data-local-link="open"]')!;
  expect(link.textContent).toBe('design/checkout.png');
  // Its href is the window's own deep link, so a new tab or a copy lands on the same file.
  expect(link.getAttribute('href')).toBe(`#thread=${AGENT_MSG}&file=att_image`);
  await act(async () => link.click());
  const mine = heading('shots/before.png').querySelector<HTMLAnchorElement>('a[data-local-link="open"]')!;
  expect(mine.getAttribute('href')).toBe(`#thread=${AGENT_MSG}&file=att_mine&v=sent`);
  await act(async () => mine.click());
  expect(opened).toEqual(['att_image@current', 'att_mine@sent']);
  // The admin page is no longer a file of the thread: its heading is text, never a link.
  expect(heading('proto/admin.html').querySelector('a, [data-local-link]')).toBeNull();
  // The drawing: a link to the drawing's own route, shown in the lightbox.
  const drawing = [...host!.querySelectorAll<HTMLAnchorElement>('a[data-local-link="open"]')].find((a) => a.textContent === 'checkout markup')!;
  expect(drawing.getAttribute('href')).toBe(`/api/inbox/markups/${'b'.repeat(64)}.png`);
  await act(async () => drawing.click());
  expect(document.querySelector<HTMLImageElement>(`img[src="/api/inbox/markups/${'b'.repeat(64)}.png"]`)).not.toBeNull();
  // With the link there, the drawing's data-dir path is not shown.
  expect(host!.textContent).not.toContain(MARKUP);
});

test.skipIf(!hasDom)("a drawing path the Inbox did not keep stays shown, with no link", async () => {
  const other = '/tmp/elsewhere/shot.png';
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody
        message={reply(`Notes.\n\n# Feedback on the attached files\n\n## design/checkout.png\n\n**Attached images:**\n- [shot] \`${other}\`\n\n---`)}
        projectRoot={ROOT}
        onOpenAttachment={() => {}}
        readOnly
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
        replyFiles={{ files: FILES, personMessageIds: PEOPLE, onOpen: () => {} }}
      />,
    );
  });
  expect(host!.querySelector('code')?.textContent).toBe(other);
  expect([...host!.querySelectorAll('a')].some((a) => a.textContent === 'shot')).toBe(false);
});

test.skipIf(!hasDom)("an agent's message draws the same headings as text, even when it is handed the thread's files", async () => {
  const text = `# Feedback on the attached files\n\n## design/checkout.png\n\n**Attached images:**\n- [checkout markup] \`${MARKUP}\`\n\n---`;
  const draw = async (author: InboxMessageWire['author']) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(
        <MessageBody
          message={{ ...reply(text), author } as InboxMessageWire}
          projectRoot={ROOT}
          onOpenAttachment={() => {}}
          readOnly
          answers={new Map()}
          onPick={() => {}}
          footerFor={() => null}
          replyFiles={{ files: FILES, personMessageIds: PEOPLE, onOpen: () => {} }}
        />,
      );
    });
    const links = host!.querySelectorAll('[data-local-link="open"]').length;
    act(() => root?.unmount());
    host!.remove();
    root = null;
    host = null;
    return links;
  };
  // The person's own reply links the heading and the drawing ...
  expect(await draw({ kind: 'person' } as InboxMessageWire['author'])).toBe(2);
  // ... an agent's message with the very same text links nothing.
  expect(await draw({ kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' } as InboxMessageWire['author'])).toBe(0);
});
