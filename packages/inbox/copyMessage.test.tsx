/**
 * Copy a message, copy a thread (design record "inbox-copy-message", option
 * B, approved 2026-10-28).
 *
 * The Markdown (no DOM): an answered question block becomes readable lines
 * with its choices and the SENT answer (a pick not sent yet shows none); a
 * block inside a code fence stays text; the person's reply keeps their words
 * and drops what the Inbox wrote for the agent; a thread is the subject, the
 * project and count, then each message under its author and time between
 * `---` (the approved sample, word for word). Drawn, a Run command with
 * backticks stays one code span, and a prompt's own bold renders beside the
 * bold Q1./A1. label instead of nesting in it.
 *
 * Attached files (DOM): a message's copy ends with "Files: …", the display
 * names in send order, drawn as plain text however odd the name; a thread
 * copy names each message's files under that message.
 *
 * The menus (DOM-gated: DOM_TESTS=1, from the test.yml DOM list), on the real
 * ThreadPane: each open message's ⋯ after Reply and its items, Copy message
 * and Copy link to message with their toasts, the header's ⋯ and Copy thread
 * (plain Markdown plus rich HTML), the keyboard (arrows, Escape, focus back
 * on ⋯), a right-click on the head line, a refused copy, and a phone (⋯
 * marked always shown, the bottom sheet with its title, no right-click).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { composeInboxReplyBody, parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAttachment, InboxAuthor, InboxInlineImage, InboxMessageWire, InboxProject, InboxQuestion, InboxQuestionRecord, InboxThread } from '@plannotator/core/inbox-types';
import { parseInboxActionBlocks } from '@plannotator/core/inbox-actions';
import { chatMarkdownToHtml } from '@plannotator/ui/utils/aiChatFormat';
import { copyTime, messageMarkdown, threadMarkdown } from './copyMarkdown';
import { threadLink } from './rowMenu';
import type { InboxToastModel } from './components/Toast';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-abcdef', name: 'billing-svc', root: '/work/billing', created_at: '2026-10-28T09:00:00.000Z' };
const CLAUDE: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const [M1, M2, M3, M4] = ['msg_01M62DTT05NJ59ZR4AJCDJ70XK', 'msg_01M62DTW6WCYD3ZH6Z17MFMA8G', 'msg_01M62DTXR00R23JW3GNA2KTM9H', 'msg_01M62DTXR74RT77ZXA4ZWGPMC8'] as const;
const PICK = 'Retry with the same idempotency key';

const FIRST = [
  'I checked the 409 handling against the Stripe docs. Here is what I found.',
  '',
  '## What happens today',
  '',
  '- The worker retries **every** error, including a 409 `idempotency_key_in_use`.',
  '- A retry with a *new* key can charge the customer twice.',
  '- Nothing logs the 409s, so we cannot tell how often it happens.',
  '',
  '```ts',
  'if (err.statusCode === 409) {',
  '  return retry(job, { sameKey: true });',
  '}',
  '```',
  '',
  ':::question',
  'Which way should the worker go on a Stripe 409?',
  'Stopped: the retry worker cannot ship without this.',
  '',
  `- [ ] ${PICK}`,
  '- [ ] Fail the job and send it to the dead-letter queue',
  `Recommended: ${PICK}`,
  ':::',
].join('\n');

const SECOND = [
  'Done. The worker now retries a 409 with the **same** idempotency key, at most 3 times, and logs each one.',
  '',
  '| File | Change |',
  '| --- | --- |',
  '| `worker/retry.ts` | same-key retry, max 3 |',
  '| `worker/log.ts` | `stripe_409` event |',
  '| `worker/retry.test.ts` | 4 new cases |',
  '',
  'Next I will run the full suite and open the PR.',
].join('\n');

const THIRD = [
  'Tests pass (212 of 212). The PR is open: [#142 Retry Stripe 409s with the same key](https://github.com/example/billing-svc/pull/142).',
  '',
  'Two things to check when you review:',
  '',
  '1. The retry cap is 3. Raise it in `RETRY_LIMIT` if you want more.',
  '2. The `stripe_409` log line carries the job id, not the customer id.',
].join('\n');

const WORDS = 'Same key. And log every 409 so we can see how often it happens.';

/** The message's questions as the thread read serves them. */
function questionsOf(messageId: string, body: string, patch: Partial<InboxQuestion> = {}): InboxQuestion[] {
  return parseInboxQuestionBlocks(body).map((q) => ({
    key: q.key,
    position: q.position,
    kind: q.kind,
    prompt: q.prompt,
    context: q.parsed.context,
    choices: q.parsed.choices,
    recommendation: q.parsed.recommendation,
    suggested_text: q.parsed.suggested_text,
    stopped: q.stopped,
    holds_up: q.holds_up,
    asked_by_agent_id: CLAUDE.session,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 1,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: messageId,
    superseded_by: null,
    ...patch,
  }));
}

function message(id: string, author: InboxAuthor, body: string, minute: number, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: M1,
    reply_to: id === M1 ? null : M1,
    author,
    subject: id === M1 ? 'Retry worker for Stripe 409s' : null,
    body,
    created_at: `2026-10-28T19:${String(minute).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    wakes: true,
    seq: minute,
    ...extra,
  };
}

/** The reply body exactly as a Send writes it for the agent: "Answered 1 question.", the words, the answers section. */
function replyBody(words: string | undefined): string {
  const parsed = parseInboxQuestionBlocks(FIRST);
  const records = parsed.map((q) => ({ ...q, id: `${M1}/${q.key}`, message_id: M1 })) as unknown as InboxQuestionRecord[];
  return composeInboxReplyBody({ questions: records, sent: [{ v: 1, key: parsed[0]!.key, kind: 'single', prompt: parsed[0]!.prompt, selected: [PICK] }], earlier: [], words });
}

function sample(state: 'sent' | 'picked' = 'sent'): InboxThread {
  const answer = { v: 1 as const, key: parseInboxQuestionBlocks(FIRST)[0]!.key, kind: 'single' as const, prompt: parseInboxQuestionBlocks(FIRST)[0]!.prompt, selected: [PICK] };
  const asked = message(M1, CLAUDE, FIRST, 30, { questions: questionsOf(M1, FIRST, { state, answer, sent_reply_id: state === 'sent' ? M2 : null }) });
  return {
    thread_id: M1,
    project: PROJECT,
    subject: 'Retry worker for Stripe 409s',
    thread_name: 'retry',
    resolved_at: null,
    messages: [asked, message(M2, { kind: 'person' }, replyBody(WORDS), 31), message(M3, CLAUDE, SECOND, 32), message(M4, CLAUDE, THIRD, 33)],
  };
}

// ── The Markdown ──

test('an answered question block reads as lines: the prompt, its context, the choices, the sent answer', () => {
  const out = messageMarkdown(sample().messages[0]!);
  expect(out).toContain(
    [
      '**Q1.** Which way should the worker go on a Stripe 409?',
      'Stopped: the retry worker cannot ship without this.',
      `- ${PICK} (recommended)`,
      '- Fail the job and send it to the dead-letter queue',
      '',
      `Answer: ${PICK}`,
    ].join('\n'),
  );
  expect(out).not.toContain(':::');
  expect(out).not.toContain('- [ ]');
  // The code fence above it is copied as written.
  expect(out).toContain('```ts\nif (err.statusCode === 409) {');
});

test('a pick not sent yet is no answer: the copy shows the choices only', () => {
  const out = messageMarkdown(sample('picked').messages[0]!);
  expect(out).toContain(`- ${PICK} (recommended)`);
  expect(out).not.toContain('Answer:');
});

test('a question block inside a code fence is text, copied as written', () => {
  const body = ['How to ask:', '', '```md', ':::question', 'Ship it?', '', '- [ ] Yes', ':::', '```'].join('\n');
  expect(messageMarkdown(message(M3, CLAUDE, body, 32))).toBe(body);
});

test('a Run command with backticks renders as one code span, the command whole', () => {
  // A backslash does not escape inside a code span: the fence must outrun the command's backticks.
  const body = (run: string) => [':::action', 'Restart the worker on the box', 'It holds the old key in memory.', `Run: ${run}`, ':::'].join('\n');
  for (const run of ['echo `date` && make ``x``', '`pwd`/bin/start']) {
    const html = chatMarkdownToHtml(messageMarkdown(message(M3, CLAUDE, body(run), 32)));
    expect(parseInboxActionBlocks(body(run))[0]!.action.run).toBe(run);
    expect(html).toContain(`<br>Run: <code>${run.replace(/&/g, '&amp;')}</code></p>`);
  }
});

test('Markdown inside a question or action prompt renders as written, the label in bold beside it', () => {
  const body = [
    ':::question',
    'Ship **only** the retry fix, or **both**?',
    '',
    '- [ ] Only the retry fix',
    '- [ ] Both',
    ':::',
    '',
    ':::action',
    'Merge the PR, then **tag** it',
    'The release waits on the tag.',
    ':::',
  ].join('\n');
  const html = chatMarkdownToHtml(messageMarkdown(message(M3, CLAUDE, body, 32)));
  expect(html).toContain('<strong>Q1.</strong> Ship <strong>only</strong> the retry fix, or <strong>both</strong>?');
  expect(html).toContain('<strong>A1.</strong> Merge the PR, then <strong>tag</strong> it');
  // No delimiter is left over as text and no bold nests inside another.
  expect(html).not.toContain('**');
  expect(html).not.toMatch(/<strong>[^<]*<strong>/);
});

test("the person's reply keeps their words and drops what the Inbox wrote for the agent", () => {
  const reply = sample().messages[1]!;
  // The stored body carries the agent-facing parts (guard: the fixture is the real Send's text).
  expect(reply.body).toContain('Answered 1 question.');
  expect(reply.body).toContain('## Answers to your questions');
  expect(messageMarkdown(reply)).toBe(WORDS);
  // A reply that carried answers and no words keeps its first line, never an empty copy.
  expect(messageMarkdown(message(M2, { kind: 'person' }, replyBody(undefined), 31))).toBe('Answered 1 question.');
});

test('a thread: the subject, the project and count, then each message under its author and time (the approved sample)', () => {
  const t = sample();
  const at = (m: number) => copyTime(t.messages[m]!.created_at);
  const expected = [
    '# Retry worker for Stripe 409s',
    '',
    'billing-svc · 4 messages',
    '',
    '---',
    '',
    `**Claude Code** · ${at(0)}`,
    '',
    messageMarkdown(t.messages[0]!),
    '',
    '---',
    '',
    `**You** · ${at(1)}`,
    '',
    WORDS,
    '',
    '---',
    '',
    `**Claude Code** · ${at(2)}`,
    '',
    SECOND,
    '',
    '---',
    '',
    `**Claude Code** · ${at(3)}`,
    '',
    THIRD,
  ].join('\n');
  expect(threadMarkdown(t)).toBe(expected);
  // "Oct 28, 2026, 7:34 PM" in the computer's time, with plain spaces (ICU's narrow space pastes oddly).
  expect(at(0)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/);
});

// ── The menus ──

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedClipboard: PropertyDescriptor | undefined;
let savedExec: unknown;
let copied: { text: string; html: string | null }[] = [];
let refuse = false;
let toasts: Omit<InboxToastModel, 'id'>[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ serverSession: 's', home: '/home/me', project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
  copied = [];
  refuse = false;
  toasts = [];
  savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (refuse) throw new Error('denied');
        copied.push({ text, html: null });
      },
      write: async (items: ClipboardItem[]) => {
        if (refuse) throw new Error('denied');
        const item = items[0]!;
        const read = async (type: string) => (item.types.includes(type) ? (await item.getType(type)).text() : null);
        copied.push({ text: (await read('text/plain')) ?? '', html: await read('text/html') });
      },
    },
  });
  // happy-dom has no copy command: the legacy fallback copies nothing.
  savedExec = (document as unknown as { execCommand?: unknown }).execCommand;
  (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  document.querySelectorAll('.ib-pm-pos, .ib-pm-scrim').forEach((n) => n.remove());
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
  (document as unknown as { execCommand: unknown }).execCommand = savedExec;
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

const LINK_BASE = { url: 'http://localhost:4321/', via: 'local' as const };

async function render(t: InboxThread, options: { phone?: boolean } = {}) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ThreadPane
        thread={t}
        sent={null}
        lookSeq={40}
        phone={options.phone === true}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        onToast={(toast) => toasts.push(toast)}
        linkOf={(messageId) => threadLink(t.thread_id, LINK_BASE, 'http://127.0.0.1:4321', messageId)}
      />,
    );
  });
  await settle();
}

const more = (id: string) => document.querySelector<HTMLButtonElement>(`[data-message-more="${id}"]`);
const messageMenu = () => document.querySelector<HTMLElement>('[data-message-menu]');
const threadMore = () => document.querySelector<HTMLButtonElement>('[data-thread-more]');
const threadMenu = () => document.querySelector<HTMLElement>('[data-thread-menu]');
const items = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
const labels = (menu: HTMLElement | null) => items(menu).map((el) => el.textContent?.trim());
const item = (menu: HTMLElement | null, name: string) => menu!.querySelector<HTMLElement>(`[data-copy-item="${name}"]`)!;

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
}

async function choose(el: HTMLElement) {
  await act(async () => el.click());
  await until(() => toasts.length > 0, 'the toast');
}

async function key(k: string) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

test.skipIf(!hasDom)("each open message's ⋯ sits after Reply; Copy message copies its Markdown and says so", async () => {
  const t = sample();
  await render(t);
  // The newest message is open: ⋯ is the last control of its head line, after Reply.
  const button = more(M4)!;
  expect(button).not.toBeNull();
  const tail = button.closest('.ib-fl-tm')!;
  const controls = [...tail.querySelectorAll('button')];
  expect(controls.at(-1)).toBe(button);
  expect(controls.at(-2)?.getAttribute('aria-label')).toBe('Reply');
  expect(button.hasAttribute('data-phone')).toBe(false);
  await press(button);
  await until(() => !!messageMenu(), 'the message menu');
  // The approved items, in order, Copy thread after a separator.
  expect(labels(messageMenu())).toEqual(['Copy message', 'Copy link to message', 'Copy thread']);
  expect(messageMenu()!.querySelector('[role="separator"]')).not.toBeNull();
  expect(button.hasAttribute('data-open')).toBe(true);
  await choose(item(messageMenu(), 'message'));
  expect(copied.map((c) => c.text)).toEqual([THIRD]);
  // The rich part is the same Markdown drawn (a paste into Gmail or Docs keeps the list and the link).
  expect(copied[0]!.html).toContain('<ol>');
  expect(copied[0]!.html).toContain('href="https://github.com/example/billing-svc/pull/142"');
  expect(toasts[0]).toMatchObject({ icon: 'check', lead: 'Message copied' });
  expect(toasts[0]!.detail).toStartWith('Claude Code, ');
  await until(() => !messageMenu(), 'the menu to close');
});

test.skipIf(!hasDom)('Copy link to message copies the thread address with the message (&msg=)', async () => {
  await render(sample());
  await press(more(M4)!);
  await until(() => !!messageMenu(), 'the message menu');
  await choose(item(messageMenu(), 'message-link'));
  expect(copied.map((c) => c.text)).toEqual([`http://localhost:4321/#thread=${M1}&msg=${M4}`]);
  expect(toasts[0]).toMatchObject({ lead: 'Link copied' });
});

test.skipIf(!hasDom)("the header's ⋯: Copy thread copies every message, folded ones too; Copy link and Copy thread ID", async () => {
  const t = sample();
  await render(t);
  // The earlier messages are folded on screen; the copy holds them anyway.
  expect(more(M1)).toBeNull();
  await press(threadMore()!);
  await until(() => !!threadMenu(), 'the thread menu');
  expect(labels(threadMenu())).toEqual(['Copy thread', 'Copy link', 'Copy thread ID']);
  await choose(item(threadMenu(), 'thread'));
  expect(copied[0]!.text).toBe(threadMarkdown(t));
  expect(copied[0]!.text).toContain(`Answer: ${PICK}`);
  expect(copied[0]!.text).not.toContain('Answers to your questions');
  expect(copied[0]!.html).toContain('<h1>Retry worker for Stripe 409s</h1>');
  expect(toasts[0]).toMatchObject({ icon: 'check', lead: 'Thread copied', detail: '4 messages' });
  await until(() => !threadMenu(), 'the menu to close');
  await press(threadMore()!);
  await until(() => !!threadMenu(), 'the thread menu again');
  await choose(item(threadMenu(), 'thread-link'));
  expect(copied[1]!.text).toBe(`http://localhost:4321/#thread=${M1}`);
  await until(() => !threadMenu(), 'the menu to close');
  await press(threadMore()!);
  await until(() => !!threadMenu(), 'the thread menu a third time');
  toasts = [];
  await choose(item(threadMenu(), 'thread-id'));
  expect(copied[2]!.text).toBe(M1);
  expect(toasts[0]).toMatchObject({ lead: 'Thread ID copied' });
});

/** An attached file as the store records it: the display name, and a local path that is never copied. */
function attached(id: string, name: string): InboxAttachment {
  return { id, path: `/work/billing/out/${id}.bin`, named_path: null, name, kind: 'file', sent_sha256: 'f'.repeat(64), size: 10, sent_at: '2026-10-28T19:33:00.000Z', sent_mtime: '2026-10-28T19:33:00.000Z' };
}

/** The paragraphs of a copy's rich part, as a paste shows them. */
function drawnParagraphs(html: string | null): HTMLParagraphElement[] {
  return [...new DOMParser().parseFromString(html ?? '', 'text/html').querySelectorAll('p')];
}

test.skipIf(!hasDom)('attached files are named at the end of the copy, in send order, as plain text', async () => {
  const ODD = 'shot, final `v2` **draft** [1]_<b>&amp;~x~ #3!.png';
  const t = sample();
  const shown = { ...attached('att_inline', 'inline-shot.png'), kind: 'image', ref: './inline-shot.png' } as unknown as InboxInlineImage;
  t.messages[3] = { ...t.messages[3]!, attachments: [attached('att_1', 'plan.md'), attached('att_2', ODD)], inline_images: [shown] };
  t.messages[0] = { ...t.messages[0]!, attachments: [attached('att_0', 'stripe-409s.log')] };
  await render(t);
  await press(more(M4)!);
  await until(() => !!messageMenu(), 'the message menu');
  await choose(item(messageMenu(), 'message'));
  // The Markdown ends with the line; the body above it is unchanged.
  expect(copied[0]!.text.startsWith(`${THIRD}\n\nFiles: `)).toBe(true);
  // Drawn, the last paragraph is the names exactly as written: no code, bold, link, tag or entity read from them.
  const last = drawnParagraphs(copied[0]!.html).at(-1)!;
  expect(last.textContent).toBe(`Files: plan.md, ${ODD}`);
  expect(last.children.length).toBe(0);
  // The display name, never the local path; an image the body shows is not an attached file.
  expect(copied[0]!.text).not.toContain('/work/billing/out');
  expect(copied[0]!.text).not.toContain('inline-shot.png');
  await until(() => !messageMenu(), 'the menu to close');

  // A thread copy names each message's files under that message; a message with none has no line.
  toasts = [];
  await press(threadMore()!);
  await until(() => !!threadMenu(), 'the thread menu');
  await choose(item(threadMenu(), 'thread'));
  const lines = drawnParagraphs(copied[1]!.html).map((p) => p.textContent).filter((text) => text?.startsWith('Files: '));
  expect(lines).toEqual(['Files: stripe-409s.log', `Files: plan.md, ${ODD}`]);
  expect(copied[1]!.text).toBe(threadMarkdown(t));
  expect(copied[1]!.text.indexOf('Files: stripe-409s.log')).toBeLessThan(copied[1]!.text.indexOf(`**You**`));
});

test.skipIf(!hasDom)('the keyboard: ⋯ opens with the arrows, the arrows walk the items, Escape closes and focus goes back to ⋯', async () => {
  await render(sample());
  const button = more(M4)!;
  await act(async () => button.focus());
  await key('ArrowDown');
  await until(() => !!messageMenu(), 'the menu from the keyboard');
  const highlighted = () => items(messageMenu()).findIndex((el) => el.hasAttribute('data-highlighted'));
  await until(() => highlighted() === 0, 'Copy message highlighted');
  await key('ArrowDown');
  await until(() => highlighted() === 1, 'Copy link to message highlighted');
  // The separator is skipped.
  await key('ArrowDown');
  await until(() => highlighted() === 2, 'Copy thread highlighted');
  await key('Escape');
  await until(() => !messageMenu(), 'the menu to close on Escape');
  await until(() => document.activeElement === button, 'focus back on ⋯');
  expect(copied).toEqual([]);
});

test.skipIf(!hasDom)('a right-click on the head line opens the same menu; Escape puts focus on its ⋯', async () => {
  await render(sample());
  const head = more(M4)!.closest<HTMLElement>('[data-open-head]')!;
  let event: MouseEvent | null = null;
  await act(async () => {
    event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 120 });
    head.querySelector('.ib-fl-nm')!.dispatchEvent(event);
  });
  await until(() => !!document.querySelector('[data-message-menu][data-context]'), 'the context menu');
  // Ours, not the browser's.
  expect(event!.defaultPrevented).toBe(true);
  expect(labels(document.querySelector('[data-message-menu][data-context]'))).toEqual(['Copy message', 'Copy link to message', 'Copy thread']);
  expect(more(M4)!.hasAttribute('data-open')).toBe(true);
  await key('Escape');
  await until(() => !messageMenu(), 'the context menu to close');
  await until(() => document.activeElement === more(M4), 'focus on the message ⋯');
});

test.skipIf(!hasDom)("a refused copy says Couldn't copy", async () => {
  await render(sample());
  refuse = true;
  await press(more(M4)!);
  await until(() => !!messageMenu(), 'the message menu');
  await choose(item(messageMenu(), 'message'));
  expect(copied).toEqual([]);
  expect(toasts[0]).toMatchObject({ icon: 'warn', lead: "Couldn't copy" });
});

test.skipIf(!hasDom)('a phone: ⋯ always shown, both menus are the bottom sheet with a title, and no right-click menu', async () => {
  const t = sample();
  await render(t, { phone: true });
  const button = more(M4)!;
  expect(button.hasAttribute('data-phone')).toBe(true);
  await press(button);
  await until(() => !!messageMenu(), 'the message sheet');
  const sheet = messageMenu()!.closest('.ib-pm-pos')!;
  expect(sheet.hasAttribute('data-phone')).toBe(true);
  expect(document.querySelector('.ib-pm-scrim')).not.toBeNull();
  expect(messageMenu()!.querySelector('.ib-pm-title')?.textContent).toStartWith('Claude Code · ');
  await key('Escape');
  await until(() => !messageMenu(), 'the sheet to close');
  await press(threadMore()!);
  await until(() => !!threadMenu(), 'the thread sheet');
  expect(threadMenu()!.closest('.ib-pm-pos')!.hasAttribute('data-phone')).toBe(true);
  expect(threadMenu()!.querySelector('.ib-pm-title')?.textContent).toBe(t.subject!);
  await key('Escape');
  await until(() => !threadMenu(), 'the thread sheet to close');
  // A long press (the platform's contextmenu) shows nothing of ours on a phone.
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  await act(async () => {
    button.closest('[data-open-head]')!.querySelector('.ib-fl-nm')!.dispatchEvent(event);
  });
  await settle();
  expect(event.defaultPrevented).toBe(false);
  expect(messageMenu()).toBeNull();
});
