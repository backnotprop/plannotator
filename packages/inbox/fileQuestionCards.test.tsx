import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { findQuestionBlocks, type QuestionAnswer } from '@plannotator/core/question-block';
import type { InboxAttachmentState, InboxQuestion } from '@plannotator/core/inbox-types';
import type { FileQuestions } from './fileQuestions';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

const PLAN = [
  '# Billing plan',
  '',
  ':::question',
  'Which database should invoices live in?',
  '',
  '- [ ] Postgres',
  '- [ ] SQLite',
  '',
  'Recommended: Postgres',
  ':::',
  '',
  ':::question',
  'Ship the retry behind a flag?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  '',
  'Recommended: Yes',
  ':::',
  '',
  ':::question',
  'Added after the send: who reviews it?',
  '',
  '- [ ] Ana',
  '- [ ] Bo',
  ':::',
].join('\n');

const MESSAGE = 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ';
const attachment: InboxAttachmentState = {
  id: 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
  path: '/work/billing/plan.md',
  named_path: null,
  name: 'plan.md',
  kind: 'markdown',
  sent_sha256: 'a'.repeat(64),
  size: PLAN.length,
  sent_at: '2026-11-09T10:00:00.000Z',
  sent_mtime: '2026-11-09T10:00:00.000Z',
  message_id: MESSAGE,
  current: { sha256: 'a'.repeat(64), size: PLAN.length, mtime: '2026-11-09T10:00:00.000Z' },
  changed_since_sent: false,
  unavailable: null,
};

const [dbKey, flagKey] = findQuestionBlocks(PLAN).map((b) => b.key) as [string, string];

function record(fileKey: string, key: string, position: number, prompt: string, labels: string[], state: InboxQuestion['state'] = 'open'): InboxQuestion {
  return {
    key,
    position,
    kind: 'single',
    prompt,
    context: null,
    choices: labels.map((label, i) => ({ label, description: null, recommended: i === 0, settled: false })),
    recommendation: labels[0]!,
    suggested_text: null,
    stopped: null,
    holds_up: [],
    asked_by_agent_id: 'ses_a',
    orphaned: false,
    state,
    answer: state === 'picked' ? { v: 1, key, kind: 'single', prompt, selected: [labels[1]!] } : null,
    revision: state === 'picked' ? 1 : 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: state === 'picked' ? '2026-11-09T10:05:00.000Z' : null,
    sent_reply_id: null,
    message_id: MESSAGE,
    superseded_by: null,
    attachment: { id: attachment.id, name: 'plan.md', key: fileKey },
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

async function mount(questions: FileQuestions | null) {
  globalThis.fetch = (async () => json({ serverSession: 's', attachment, version: 'current', text: PLAN, html: null })) as unknown as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const noop = () => {};
  await act(async () => {
    root!.render(
      <AttachmentPane
        attachment={attachment}
        attachments={[attachment]}
        records={[]}
        agent="Claude Code"
        projectName="billing"
        projectRoot="/work/billing"
        version="current"
        onVersion={noop}
        full={false}
        onToggleFull={noop}
        focusId={null}
        readOnly={false}
        onSaved={noop}
        onRemoved={noop}
        onOpenAt={noop}
        onClose={noop}
        strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
        questions={questions}
      />,
    );
  });
  await act(async () => {
    for (let i = 0; i < 200 && host!.querySelectorAll('fieldset[data-question-key]').length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  });
  const cards = [...host!.querySelectorAll<HTMLFieldSetElement>('fieldset[data-question-key]')];
  expect(cards).toHaveLength(3);
  return cards;
}

const buttonIn = (card: HTMLElement, label: string) => [...card.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const radiosLive = (card: HTMLElement) => {
  const radios = [...card.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  return radios.length > 0 && radios.every((r) => !r.disabled);
};

function questionsWith(records: InboxQuestion[], picks: { key: string; answer: QuestionAnswer | null }[], locked = false): FileQuestions {
  return {
    records,
    answers: new Map(records.flatMap((r) => (r.answer ? [[r.key, r.answer] as const] : []))),
    locked,
    onPick: (key, answer) => picks.push({ key, answer }),
    footerFor: (key) => (records.find((r) => r.key === key)?.state === 'picked' ? 'Picked 10:05 AM · in your draft' : null),
  };
}

test.skipIf(!hasDom)("a recorded card takes a pick, sent under the record's key; a card no record names stays read-only", async () => {
  const picks: { key: string; answer: QuestionAnswer | null }[] = [];
  const records = [record(dbKey, dbKey, 0, 'Which database should invoices live in?', ['Postgres', 'SQLite']), record(flagKey, `${flagKey}-2`, 1, 'Ship the retry behind a flag?', ['Yes', 'No'])];
  const [db, flag, added] = await mount(questionsWith(records, picks));
  expect(radiosLive(db!)).toBe(true);
  expect(radiosLive(flag!)).toBe(true);
  expect(buttonIn(flag!, 'Accept recommended')).toBeDefined();
  expect(radiosLive(added!)).toBe(false);
  expect(buttonIn(added!, 'Accept recommended')).toBeUndefined();

  await act(async () => buttonIn(flag!, 'Accept recommended')!.click());
  expect(picks).toHaveLength(1);
  expect(picks[0]!.key).toBe(`${flagKey}-2`);
  expect(picks[0]!.answer?.selected).toEqual(['Yes']);
});

test.skipIf(!hasDom)('a pick not sent reads Draft with its footer; a locked message locks every card', async () => {
  const records = [record(dbKey, dbKey, 0, 'Which database should invoices live in?', ['Postgres', 'SQLite'], 'picked'), record(flagKey, flagKey, 1, 'Ship the retry behind a flag?', ['Yes', 'No'])];
  const [db] = await mount(questionsWith(records, []));
  expect(db!.textContent).toContain('Draft');
  expect(db!.textContent).toContain('Picked 10:05 AM · in your draft');
  expect(db!.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.closest('label')?.textContent).toContain('SQLite');
  act(() => root?.unmount());
  host?.remove();

  const picks: { key: string; answer: QuestionAnswer | null }[] = [];
  const cards = await mount(questionsWith(records, picks, true));
  expect(cards.some(radiosLive)).toBe(false);
  expect(cards.every((card) => buttonIn(card, 'Accept recommended') === undefined)).toBe(true);
});

test.skipIf(!hasDom)('a sent question in the file is read-only beside an open one', async () => {
  const records = [record(dbKey, dbKey, 0, 'Which database should invoices live in?', ['Postgres', 'SQLite'], 'sent'), record(flagKey, flagKey, 1, 'Ship the retry behind a flag?', ['Yes', 'No'])];
  const [db, flag] = await mount(questionsWith(records, []));
  expect(radiosLive(db!)).toBe(false);
  expect(radiosLive(flag!)).toBe(true);
});
