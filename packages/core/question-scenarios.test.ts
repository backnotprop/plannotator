/**
 * The scenario table of a question block: read only when every option header
 * names a different choice, within the caps; any other table stays context,
 * drawn exactly as before.
 */
import { describe, expect, test } from 'bun:test';
import { parseQuestionBlock } from './question-block';
import { parseInboxQuestionBlocks, toInboxQuestion } from './inbox-questions';
import { MAX_QUESTION_SCENARIO_CELL_CHARS, MAX_QUESTION_SCENARIO_ROWS, splitScenarioCell } from './question-scenarios';

const HEAD = [
  'Where should an edit that loses a sync conflict go?',
  '',
  '- [ ] Nowhere — the losing edit is dropped',
  '- [ ] Local only, purged after 30 days — kept on the device that lost',
  '- [ ] Server-side per user — kept on our server, for every device',
  '',
  'Recommended: Local only, purged after 30 days',
  'Why: covers a plane or a train with no server work.',
  '',
];
const TABLE = [
  '| Scenario | Nowhere | Local only | Server-side |',
  '| --- | --- | --- | --- |',
  '| You edit offline on a plane | Lost — nothing says so | Kept — in the note\'s History | Kept — on every device |',
  '| Ada and Bob edit the same line | Lost | Kept on Bob\'s laptop — Ada can\'t see it | Kept — both see it |',
];
const body = (table: string[], tail: string[] = []) => [...HEAD, ...table, ...tail].join('\n');
const parse = (text: string) => parseQuestionBlock('question', text)!;

describe('scenario table', () => {
  test('headers name choices by label or first words; cells split into verdict and detail; the table leaves the context', () => {
    const q = parse(body(TABLE, ['', 'Some closing words.']));
    expect(q.scenarios).toEqual({
      columns: [
        { choice: 'Nowhere', header: 'Nowhere' },
        { choice: 'Local only, purged after 30 days', header: 'Local only' },
        { choice: 'Server-side per user', header: 'Server-side' },
      ],
      rows: [
        {
          situation: 'You edit offline on a plane',
          cells: [
            { verdict: 'Lost', detail: 'nothing says so' },
            { verdict: 'Kept', detail: 'in the note\'s History' },
            { verdict: 'Kept', detail: 'on every device' },
          ],
        },
        {
          situation: 'Ada and Bob edit the same line',
          cells: [
            { verdict: 'Lost' },
            { verdict: 'Kept on Bob\'s laptop', detail: 'Ada can\'t see it' },
            { verdict: 'Kept', detail: 'both see it' },
          ],
        },
      ],
    });
    expect(q.context).not.toContain('|');
    expect(q.context).toContain('Some closing words.');
    // The key, choices and recommendation are what they were without the table.
    const without = parse(body([]));
    expect(q.key).toBe(without.key);
    expect(q.choices).toEqual(without.choices);
  });

  test('columns may name a subset of the choices, in any order', () => {
    const q = parse(body(['| | Server-side per user | Nowhere |', '|---|:-:|--:|', '| Reinstall | Kept | Lost |']));
    expect(q.scenarios?.columns.map((c) => c.choice)).toEqual(['Server-side per user', 'Nowhere']);
  });

  const refused: [string, string[]][] = [
    ['a header that names no choice', ['| Scenario | Nowhere | Somewhere |', '| --- | --- | --- |', '| x | a | b |']],
    ['two headers naming one choice', ['| Scenario | Nowhere | Nowhere |', '| --- | --- | --- |', '| x | a | b |']],
    ['a header that is part of a word', ['| Scenario | Nowhere | Lo |', '| --- | --- | --- |', '| x | a | b |']],
    ['more columns than choices plus one', ['| S | Nowhere | Local only | Server-side | Nowhere again |', '| - | - | - | - | - |', '| x | a | b | c | d |']],
    ['zero body rows', ['| Scenario | Nowhere | Local only |', '| --- | --- | --- |']],
    ['no delimiter row', ['| Scenario | Nowhere | Local only |', '| x | a | b |']],
    ['a row with a missing cell', ['| Scenario | Nowhere | Local only |', '| --- | --- | --- |', '| x | a |']],
    ['an empty situation', ['| Scenario | Nowhere | Local only |', '| --- | --- | --- |', '|  | a | b |']],
    ['an empty option header', ['| Scenario | Nowhere | |', '| --- | --- | --- |', '| x | a | b |']],
    ['one option column', ['| Scenario | Nowhere |', '| --- | --- |', '| x | a |']],
  ];
  for (const [name, table] of refused) {
    test(`not a scenario table: ${name}; it stays context as written`, () => {
      const q = parse(body(table));
      expect(q.scenarios).toBeUndefined();
      expect(q.context).toContain(table[0]!);
    });
  }

  test('caps: too many rows, or a cell too long, keeps the table as context', () => {
    const row = (i: number) => `| Case ${i} | a | b | c |`;
    const head = TABLE.slice(0, 2);
    const atCap = Array.from({ length: MAX_QUESTION_SCENARIO_ROWS }, (_, i) => row(i));
    expect(parse(body([...head, ...atCap])).scenarios?.rows).toHaveLength(MAX_QUESTION_SCENARIO_ROWS);
    expect(parse(body([...head, ...atCap, row(99)])).scenarios).toBeUndefined();
    const long = 'x'.repeat(MAX_QUESTION_SCENARIO_CELL_CHARS + 1);
    expect(parse(body([...head, `| Case | ${long} | b | c |`])).scenarios).toBeUndefined();
    expect(parse(body([...head, `| Case | ${long.slice(1)} | b | c |`])).scenarios).toBeDefined();
  });

  test('escaped pipes and inline code survive in cells', () => {
    const q = parse(body([...TABLE.slice(0, 2), '| Uses `a \\| b` | Lost — `x — y` stays code | a \\| b — c | Kept |']));
    expect(q.scenarios?.rows[0]).toEqual({
      situation: 'Uses `a | b`',
      cells: [{ verdict: 'Lost', detail: '`x — y` stays code' }, { verdict: 'a | b', detail: 'c' }, { verdict: 'Kept' }],
    });
    expect(splitScenarioCell('`a — b`')).toEqual({ verdict: '`a — b`' });
    expect(splitScenarioCell('Kept – en dash')).toEqual({ verdict: 'Kept', detail: 'en dash' });
  });

  test('a header whose first words begin two labels names neither', () => {
    const q = parse([
      'Where do we keep it?',
      '- [ ] Keep local — on this laptop',
      '- [ ] Keep remote — on the server',
      '',
      '| Case | Keep | Keep remote |',
      '| --- | --- | --- |',
      '| Offline | a | b |',
    ].join('\n'));
    expect(q.scenarios).toBeUndefined();
    expect(q.context).toContain('| Case | Keep | Keep remote |');
  });

  test('two qualifying tables: neither is read', () => {
    const q = parse(body([...TABLE, '', ...TABLE]));
    expect(q.scenarios).toBeUndefined();
  });

  test('a table in a code fence, an indented table and a free-text question are never read', () => {
    expect(parse(body(['```', ...TABLE, '```'])).scenarios).toBeUndefined();
    expect(parse(body(TABLE.map((l) => `    ${l}`))).scenarios).toBeUndefined();
    const text = parseQuestionBlock('question-text', ['What should it be called?', '', ...TABLE].join('\n'))!;
    expect(text.scenarios).toBeUndefined();
  });

  test('plain-bullet choices and a lettered header match as Recommended does', () => {
    const q = parse([
      'Which drawer?',
      '- A · Total on top — closest to today',
      '- B · Total pinned — never scrolls away',
      '',
      '| When | A | B |',
      '| --- | --- | --- |',
      '| Long cart | Scrolls — total hidden | Stays — total visible |',
    ].join('\n'));
    expect(q.scenarios?.columns.map((c) => c.choice)).toEqual(['A · Total on top', 'B · Total pinned']);
  });

  test('the Inbox record and the wire carry it; a record without it reads as before', () => {
    const [stored] = parseInboxQuestionBlocks(['Intro', '', ':::question', body(TABLE), ':::'].join('\n'));
    expect(stored!.parsed.scenarios?.rows).toHaveLength(2);
    const record = {
      id: 'm/q', project_id: 'p', message_id: 'm', thread_id: 't', key: stored!.key, position: 0, kind: stored!.kind,
      prompt: stored!.prompt, parsed: stored!.parsed, stopped: null, holds_up: [], asked_by_agent_id: null, answer: null,
      revision: 0, sent_revision: null, picked_by: null, picked_at: null, sent_reply_id: null, superseded_by: null,
    } as unknown as Parameters<typeof toInboxQuestion>[0];
    const wire = toInboxQuestion(record, false);
    expect(wire.scenarios).toEqual(stored!.parsed.scenarios);
    expect(wire.scenarios).not.toBe(stored!.parsed.scenarios);
    const { scenarios: _s, ...older } = stored!.parsed;
    expect(toInboxQuestion({ ...record, parsed: older } as typeof record, false).scenarios).toBeUndefined();
  });
});
