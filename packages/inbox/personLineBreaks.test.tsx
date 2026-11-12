import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';

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

const AGENT = { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' } as const;
const PERSON = { kind: 'person' } as const;

async function render(body: string, author: InboxMessageWire['author']) {
  const message = {
    id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    thread_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    project_id: 'prj_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    author,
    body,
    attachments: [],
    questions: [],
  } as unknown as InboxMessageWire;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody message={message} projectRoot="/work/widgets" onOpenAttachment={() => {}} readOnly answers={new Map()} onPick={() => {}} footerFor={() => null} />,
    );
  });
  return host;
}

const OWNER = 'this\nis\na\ntest\n\n\n\n\n\n\na lot test';

test.skipIf(!hasDom)("a person's single newlines are line breaks and their run of blank lines is kept", async () => {
  const el = await render(OWNER, PERSON);
  const paragraphs = [...el.querySelectorAll('p')];
  expect(paragraphs).toHaveLength(2);
  expect(paragraphs[0]!.querySelectorAll('br')).toHaveLength(3);
  expect(paragraphs[0]!.getAttribute('data-blank-lines')).toBeNull();
  expect(paragraphs[1]!.getAttribute('data-blank-lines')).toBe('6');
});

test.skipIf(!hasDom)('one blank line stays the ordinary paragraph gap', async () => {
  const el = await render('a\n\nb', PERSON);
  expect(el.querySelectorAll('p')).toHaveLength(2);
  expect(el.querySelector('[data-blank-lines]')).toBeNull();
});

test.skipIf(!hasDom)("an agent's message renders as before: soft breaks fold, blank lines collapse", async () => {
  const el = await render(OWNER, AGENT);
  expect(el.querySelectorAll('br')).toHaveLength(0);
  expect(el.querySelector('[data-blank-lines]')).toBeNull();
  expect(el.querySelectorAll('p')[0]!.textContent).toBe('this\nis\na\ntest');
});

test.skipIf(!hasDom)("a person's fenced code, list, table and quote keep their structure", async () => {
  const body = ['```\nx\ny\n```', '', '- one\n- two', '', '| a | b |\n|---|---|\n| 1 | 2 |', '', '> q1\n> q2'].join('\n');
  const person = await render(body, PERSON);
  const code = person.querySelector('pre code');
  expect(code?.textContent).toBe('x\ny');
  expect(code?.querySelectorAll('br')).toHaveLength(0);
  expect(person.querySelectorAll('table')).toHaveLength(1);
  expect(person.querySelectorAll('td')).toHaveLength(2);
  const items = (el: HTMLElement) => [...el.querySelectorAll('[data-rich-list-kind="ul"]')].map((li) => li.lastElementChild?.textContent);
  expect(items(person)).toEqual(['one', 'two']);
  expect(person.querySelectorAll('blockquote')).toHaveLength(1);
  expect(person.querySelectorAll('blockquote p')).toHaveLength(1);
  expect(person.querySelectorAll('blockquote p br')).toHaveLength(1);
  const shape = (el: HTMLElement) => [...el.querySelectorAll('[data-block-id]')].map((b) => b.tagName);
  const personShape = shape(person);
  act(() => root?.unmount());
  host?.remove();
  const agent = await render(body, AGENT);
  expect(agent.querySelector('pre code')?.textContent).toBe('x\ny');
  expect(items(agent)).toEqual(['one', 'two']);
  expect(agent.querySelectorAll('blockquote p br')).toHaveLength(0);
  expect(shape(agent)).toEqual(personShape);
});

test.skipIf(!hasDom)("a sent reply's rest and its feedback keep the person's line breaks too", async () => {
  const body = [
    'Answered 1 question.',
    '',
    'my words',
    '',
    "No questions answered yet; 1 question still open. Don't re-ask it; the person will answer in the Inbox.",
    '',
    'rest one',
    'rest two',
    '',
    '# Feedback on the attached files',
    '',
    '## plan.md',
    '',
    'feedback one',
    'feedback two',
  ].join('\n');
  const el = await render(body, PERSON);
  const rest = el.querySelector('[data-sent-rest]');
  expect(rest?.querySelectorAll('br').length).toBe(1);
  expect(rest?.textContent).toContain('rest one');
  const feedback = el.querySelector('[data-reply-feedback]');
  expect(feedback?.textContent).toContain('feedback one');
  expect(feedback?.querySelectorAll('br').length).toBe(1);
});
