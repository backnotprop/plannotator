/** The Board prompt names only ops, arguments and columns that the `card` action takes. */
import { expect, test } from 'bun:test';
import { INBOX_CARD_COLUMNS } from '@plannotator/core/inbox-types';
import { INBOX_CARD_OP_FIELDS, INBOX_CARD_OPS } from './inbox-mcp-cards';
import { INBOX_CARD_INITIATIVE_CLEAR_OUT, INBOX_CARD_INITIATIVE_RULE } from '@plannotator/core/inbox-types';
import { boardPrompt } from '../inbox/board/boardPrompt';

const BIN = ['/Users/ada/.local/bin/plannotator', 'inbox', 'mcp'];

test('every op and argument the prompt names is one the card action takes', () => {
  const prompt = boardPrompt(BIN);
  const fields = new Set<string>(['op', 'project_path', ...Object.values(INBOX_CARD_OP_FIELDS).flat()]);
  const ops = new Set<string>(INBOX_CARD_OPS);
  const named = [...prompt.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
  expect(named.length).toBeGreaterThan(10);
  for (const word of named) {
    const known = fields.has(word) || ops.has(word) || word === 'card' || word === 'plannotator_inbox' || word === 'board_off';
    expect(known, `\`${word}\` is not an op or argument of the card action`).toBe(true);
  }
  for (const match of prompt.matchAll(/op `([a-z_]+)`/g)) expect(ops.has(match[1])).toBe(true);
  expect(prompt).toContain('`asked_by: "anyone"`');
  expect(INBOX_CARD_OP_FIELDS.list).toContain('asked_by');
});

test('the columns it lists are the store’s v2 ids, Todo takes work not started, and only a hand-over goes to In review', () => {
  const prompt = boardPrompt(BIN);
  const listed = [...prompt.matchAll(/^- ([a-z_]+): /gm)].map((match) => match[1]);
  expect(listed).toEqual(['todo', 'in_progress', 'in_review', 'backlog']);
  for (const column of listed) expect(INBOX_CARD_COLUMNS).toContain(column as (typeof INBOX_CARD_COLUMNS)[number]);
  expect(prompt).toMatch(/- todo: work you were asked to do and have not started\./);
  expect(prompt).toMatch(/- in_review: [^\n]*handed to me on purpose/);
  expect(prompt).toMatch(/A question you ask me mid-work leaves the card in in_progress\./);
  expect(prompt).not.toMatch(/icebox|designing|your_look|your_review|\bbuilding\b/i);
});

test('it asks for 2–5 word titles with status in `say`, and the thread where the person decides linked with `thread_id`', () => {
  const prompt = boardPrompt(BIN);
  expect(prompt).toContain('2–5 words naming the work');
  expect(prompt).toContain('never a sentence; where it stands goes in `say`');
  expect(prompt).toMatch(/link the Inbox thread where I make the call \(`thread_id`\)/);
});

test('it names this computer’s plannotator for the CLI, and a plain one before the settings load', () => {
  expect(boardPrompt(BIN)).toContain('`/Users/ada/.local/bin/plannotator card --help`');
  expect(boardPrompt(null)).toContain('`plannotator card --help`');
});

test('it carries the initiative rule but not the sentence on clearing initiatives out (card --help and the nudge only)', () => {
  const prompt = boardPrompt(BIN);
  expect(prompt).toContain(INBOX_CARD_INITIATIVE_RULE);
  expect(prompt).not.toContain(INBOX_CARD_INITIATIVE_CLEAR_OUT);
  expect(prompt).not.toMatch(/delete it/);
});
