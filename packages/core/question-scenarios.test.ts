/**
 * The scenario table of a question block: read only when every option header
 * names a different choice and a cell is `<verdict> — <detail>`, within the
 * caps; any other table is only context, drawn exactly as before. Additive:
 * the table's lines stay in `context` (the record, the wire, and every reader
 * that does not draw the section, see them as before); only the card leaves
 * them out of what it renders (`contextWithoutScenarioTable`).
 */
import { describe, expect, test } from 'bun:test';
import { parseQuestionBlock } from './question-block';
import { parseInboxQuestionBlocks, toInboxQuestion } from './inbox-questions';
import { contextWithoutScenarioTable, MAX_QUESTION_SCENARIO_CELL_CHARS, MAX_QUESTION_SCENARIO_ROWS, splitScenarioCell } from './question-scenarios';

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
  test('headers name choices by label or first words; cells split into verdict and detail; the table stays in the context', () => {
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
    // Additive: the context is what it is without the field (as on main), table and all.
    for (const line of TABLE) expect(q.context).toContain(line);
    expect(q.context).toContain('Some closing words.');
    // The key, choices and recommendation are what they were without the table.
    const without = parse(body([]));
    expect(q.key).toBe(without.key);
    expect(q.choices).toEqual(without.choices);
  });

  test('columns may name a subset of the choices, in any order', () => {
    const q = parse(body(['| | Server-side per user | Nowhere |', '|---|:-:|--:|', '| Reinstall | Kept — on our server | Lost |']));
    expect(q.scenarios?.columns.map((c) => c.choice)).toEqual(['Server-side per user', 'Nowhere']);
  });

  const refused: [string, string[]][] = [
    ['a header that names no choice', ['| Scenario | Nowhere | Somewhere |', '| --- | --- | --- |', '| x | a — 1 | b |']],
    ['two headers naming one choice', ['| Scenario | Nowhere | Nowhere |', '| --- | --- | --- |', '| x | a — 1 | b |']],
    ['a header that is part of a word', ['| Scenario | Nowhere | Lo |', '| --- | --- | --- |', '| x | a — 1 | b |']],
    ['more columns than choices plus one', ['| S | Nowhere | Local only | Server-side | Nowhere again |', '| - | - | - | - | - |', '| x | a — 1 | b | c | d |']],
    ['zero body rows', ['| Scenario | Nowhere | Local only |', '| --- | --- | --- |']],
    ['no delimiter row', ['| Scenario | Nowhere | Local only |', '| x | a — 1 | b |']],
    ['a row with a missing cell', ['| Scenario | Nowhere | Local only |', '| --- | --- | --- |', '| x | a — 1 |']],
    ['an empty situation', ['| Scenario | Nowhere | Local only |', '| --- | --- | --- |', '|  | a — 1 | b |']],
    ['an empty option header', ['| Scenario | Nowhere | |', '| --- | --- | --- |', '| x | a — 1 | b |']],
    ['one option column', ['| Scenario | Nowhere |', '| --- | --- |', '| x | a — 1 |']],
  ];
  for (const [name, table] of refused) {
    test(`not a scenario table: ${name}; it stays context as written`, () => {
      const q = parse(body(table));
      expect(q.scenarios).toBeUndefined();
      expect(q.context).toContain(table[0]!);
    });
  }

  test('caps: too many rows, or a cell too long, keeps the table as context', () => {
    const row = (i: number) => `| Case ${i} | a — 1 | b | c |`;
    const head = TABLE.slice(0, 2);
    const atCap = Array.from({ length: MAX_QUESTION_SCENARIO_ROWS }, (_, i) => row(i));
    expect(parse(body([...head, ...atCap])).scenarios?.rows).toHaveLength(MAX_QUESTION_SCENARIO_ROWS);
    expect(parse(body([...head, ...atCap, row(99)])).scenarios).toBeUndefined();
    const long = 'x'.repeat(MAX_QUESTION_SCENARIO_CELL_CHARS + 1);
    expect(parse(body([...head, `| Case | ${long} | b — 1 | c |`])).scenarios).toBeUndefined();
    expect(parse(body([...head, `| Case | ${long.slice(1)} | b — 1 | c |`])).scenarios).toBeDefined();
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
      '| Offline | a — 1 | b |',
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
    // Additive: the record's and the wire's context still carry the table, so the phone card, the Decisions card,
    // "Show the old options", search and WebMCP show it where they did.
    for (const line of TABLE) {
      expect(stored!.parsed.context).toContain(line);
      expect(wire.context).toContain(line);
    }
    const { scenarios: _s, ...older } = stored!.parsed;
    expect(toInboxQuestion({ ...record, parsed: older } as typeof record, false).scenarios).toBeUndefined();

    // A hand-edited record: a null column, row or cell, or a word that is not a string, drops the field, never throws.
    const good = stored!.parsed.scenarios!;
    const broken: unknown[] = [
      null,
      { columns: null, rows: good.rows },
      { columns: [null, ...good.columns.slice(1)], rows: good.rows },
      { columns: good.columns, rows: [null] },
      { columns: good.columns, rows: [{ situation: 'x', cells: [null, null, null] }] },
      { columns: good.columns, rows: [{ situation: 'x', cells: null }] },
      { columns: [{ choice: 1, header: 'Nowhere' }], rows: good.rows },
      { columns: good.columns, rows: [{ situation: 'x', cells: [{ verdict: 'Lost', detail: 7 }] }] },
    ];
    for (const scenarios of broken) {
      const odd = { ...record, parsed: { ...stored!.parsed, scenarios } } as typeof record;
      expect(() => toInboxQuestion(odd, false)).not.toThrow();
      expect(toInboxQuestion(odd, false).scenarios).toBeUndefined();
      expect(toInboxQuestion(odd, false).context).toBe(wire.context);
    }
  });

  test('an ordinary comparison table (no `<verdict> — <detail>` cell) is not a scenario table: it stays context as on main', () => {
    const ask = (rows: string[]) => parse([
      'Which database?',
      '',
      '- [ ] Postgres',
      '- [ ] SQLite',
      '',
      '| Feature | Postgres | SQLite |',
      '| --- | --- | --- |',
      ...rows,
    ].join('\n'));
    const plain = ask(['| Replication | Yes | No |', '| Runs in-process | No | Yes |', '| Costs | a – b | Free |']);
    expect(plain.scenarios).toBeUndefined();
    expect(plain.context).toContain('| Feature | Postgres | SQLite |');
    // One cell written verdict — detail makes it one.
    const one = ask(['| Replication | Yes — streaming | No |', '| Runs in-process | No | Yes |']);
    expect(one.scenarios?.columns.map((c) => c.choice)).toEqual(['Postgres', 'SQLite']);
    expect(one.scenarios?.rows[0]!.cells[0]).toEqual({ verdict: 'Yes', detail: 'streaming' });
    // A dash inside inline code, or with nothing before or after it, does not count.
    expect(ask(['| Replication | `a — b` | No |']).scenarios).toBeUndefined();
    expect(ask(['| Replication | — streaming | No |']).scenarios).toBeUndefined();
  });

  test('a line right after the table without a leading pipe ends it, as the card\'s renderer draws it', () => {
    const q = parse(body(TABLE.slice(0, 3), ['Local only — and nothing else']));
    expect(q.scenarios?.rows).toHaveLength(1);
    expect(q.context).toContain('Local only — and nothing else');
  });
});

describe('the context the card draws (contextWithoutScenarioTable)', () => {
  const strip = (lines: string[]) => {
    const q = parse(body(lines));
    return contextWithoutScenarioTable(q.context, q.scenarios!);
  };

  test('the table leaves; the paragraph above and the one below stay two paragraphs', () => {
    const drawn = strip(['Above the table.', ...TABLE, 'Below the table.']);
    expect(drawn).toBe('Above the table.\n\nBelow the table.');
    expect(strip(['Above.', '', ...TABLE, '', 'Below.'])).toBe('Above.\n\nBelow.');
  });

  test('a table at either end leaves no blank line; a table alone leaves nothing', () => {
    expect(strip(['Above.', '', ...TABLE])).toBe('Above.');
    expect(strip([...TABLE, '', 'Below.'])).toBe('Below.');
    expect(strip(TABLE)).toBe('');
  });

  test('only that table leaves: another table and a copy in a code fence stay', () => {
    const other = ['| Cost | Now |', '| --- | --- |', '| Storage | 3 GB |'];
    const drawn = strip(['```', ...TABLE, '```', '', ...other, '', ...TABLE]);
    expect(drawn).toContain('| Cost | Now |');
    expect(drawn.split(TABLE[0]!).length - 1).toBe(1);
    expect(drawn).toContain('```');
  });

  test('a context without the table (an edited record) comes back as it is', () => {
    const q = parse(body(TABLE));
    expect(contextWithoutScenarioTable('Just words.', q.scenarios!)).toBe('Just words.');
  });
});
