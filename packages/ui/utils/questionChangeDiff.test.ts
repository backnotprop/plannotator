/**
 * The word marks of a question's before and after (approval "before-after").
 *
 * What regresses if this fails: a rewrite reads as confetti (kept words
 * scattered between marks), a mostly rewritten line is struck red end to end
 * or marked as 90% green, markdown syntax is split by a mark (a broken link,
 * stray `**`), or lines pair up wrongly so an unchanged neighbour is marked.
 */
import { describe, expect, test } from 'bun:test';
import {
  QUESTION_CHANGE_MAX_DIFF_CHARS,
  QUESTION_CHANGE_WHOLE_LINE_SHARE,
  diffQuestionChange,
  questionChangeMarkedRuns,
  questionChangePlainText,
  setQuestionChangeDiffClock,
  type QuestionChangeRow,
} from './questionChangeDiff';

/** A side as text: removed words as [-…-], added as {+…+}. */
const side = (row: QuestionChangeRow, which: 'before' | 'after'): string => {
  if (row.type !== 'mod') throw new Error(`not a changed pair: ${row.type}`);
  const tokens = which === 'before' ? row.beforeTokens : row.afterTokens;
  let out = '';
  let open = false;
  for (const t of tokens) {
    if (t.mark && !open) { out += which === 'before' ? '[-' : '{+'; open = true; }
    if (!t.mark && open) { out += which === 'before' ? '-]' : '+}'; open = false; }
    out += t.text;
  }
  return out + (open ? (which === 'before' ? '-]' : '+}') : '');
};

describe('word marks', () => {
  test('a small edit marks only the changed words, on both sides', () => {
    const [row] = diffQuestionChange(
      'A soft doorbell when an agent asks you something and this tab is hidden.',
      'A soft doorbell when an agent sends you something and this tab is hidden.',
    );
    expect(side(row, 'before')).toBe('A soft doorbell when an agent [-asks-] you something and this tab is hidden.');
    expect(side(row, 'after')).toBe('A soft doorbell when an agent {+sends+} you something and this tab is hidden.');
  });

  test('a lone unchanged word between two changes joins them on both sides, so a rewrite reads as one run and a word is kept on both or neither', () => {
    const [row] = diffQuestionChange('When an agent asks you', 'When an agent sends you something');
    expect(side(row, 'after')).toBe('When an agent {+sends you something+}');
    expect(side(row, 'before')).toBe('When an agent [-asks you-]');
    // Punctuation between two changes is never swallowed.
    const [comma] = diffQuestionChange('red, blue', 'green, yellow');
    expect(comma.type === 'mod' && comma.whole).toBe(true);
  });

  test(`a line that keeps under ${QUESTION_CHANGE_WHOLE_LINE_SHARE * 100}% of its words carries no marks on either side`, () => {
    const [row] = diffQuestionChange(
      'Changed since Claude Code sent it at 5:40 PM. Edited 5:51 PM. [Open the version it sent](#)',
      'You are viewing the file as it is now, edited 5:51 PM. [Open the version Claude Code sent](#)',
    );
    expect(row.type === 'mod' && row.whole).toBe(true);
    if (row.type === 'mod') {
      expect(row.beforeTokens.some((t) => t.mark)).toBe(false);
      expect(row.afterTokens.some((t) => t.mark)).toBe(false);
    }
    // Just over the share: marked.
    const [kept] = diffQuestionChange('one two three four five', 'one two six seven eight');
    expect(kept.type === 'mod' && kept.whole).toBe(false);
  });

  test('a link, a code span or a picture is one token, and bold travels as a flag: a mark never splits markdown', () => {
    const [row] = diffQuestionChange(
      'The version **it sent** at 5:40 PM. [Open the file as it is now](#)',
      'You are viewing the version **it sent** at 5:40 PM. [Open the file as it is now](#)',
    );
    // (The card draws a run's edge spaces outside its mark.)
    expect(side(row, 'after')).toBe('{+You are viewing the +}version it sent at 5:40 PM. Open the file as it is now');
    if (row.type === 'mod') {
      expect(row.afterTokens.filter((t) => t.kind === 'link').map((t) => t.text)).toEqual(['Open the file as it is now']);
      expect(row.afterTokens.filter((t) => t.bold).map((t) => t.text).join('')).toBe('it sent');
    }
    const [code] = diffQuestionChange('Run `bun test` now please', 'Run `bun run test` now please');
    expect(side(code, 'before')).toBe('Run [-bun test-] now please');
  });

  test('lines pair by their text: unchanged neighbours stay unchanged, an added line is its own row', () => {
    const rows = diffQuestionChange(
      '**Plannotator Inbox**\nThe person keeps an Inbox.\nUse send_message to ask.',
      '**Plannotator Inbox**\nWhile the person is away, send decisions to the Inbox.\nThe person keeps an Inbox.\nUse send_message to ask.',
    );
    expect(rows.map((r) => r.type)).toEqual(['same', 'add', 'same', 'same']);
    const list = diffQuestionChange('- One\n- Two\n- Three', '- One\n- Two, changed\n- Three');
    expect(list.map((r) => r.type)).toEqual(['same', 'mod', 'same']);
    expect(list[1].type === 'mod' && list[1].after.kind).toBe('li');
  });

  test('no Before or no After: every line is on one side', () => {
    expect(diffQuestionChange(null, 'New line').map((r) => r.type)).toEqual(['add']);
    expect(diffQuestionChange('Old line', null).map((r) => r.type)).toEqual(['del']);
  });
});

describe('writing systems and size', () => {
  test('writing with no spaces between words carries no marks: both lines whole, never one mark over the clause', () => {
    const [row] = diffQuestionChange('设置已保存到草稿。', '设置已保存到你的草稿。');
    expect(row.type === 'mod' && row.whole).toBe(true);
    const [thai] = diffQuestionChange('บันทึกแล้ว', 'บันทึกลงร่างแล้ว');
    expect(thai.type === 'mod' && thai.whole).toBe(true);
  });

  test('a mark never splits an emoji sequence or a letter from its accent', () => {
    const [row] = diffQuestionChange('Ship it 👍🏽 today, team 👩‍💻 ready', 'Ship it 👍🏽 tomorrow, team 👩‍💻 ready');
    if (row.type !== 'mod') throw new Error('not a changed pair');
    expect(row.afterTokens.map((t) => t.text)).toContain('👍🏽');
    expect(row.afterTokens.map((t) => t.text)).toContain('👩‍💻');
    expect(side(row, 'after')).toBe('Ship it 👍🏽 {+tomorrow+}, team 👩‍💻 ready');
    const [accent] = diffQuestionChange('Cafe\u0301 open', 'Cafe\u0301 closed');
    if (accent.type !== 'mod') throw new Error('not a changed pair');
    expect(accent.beforeTokens[0]!.text).toBe('Cafe\u0301');
  });

  test(`a pair over ${QUESTION_CHANGE_MAX_DIFF_CHARS} characters is never diffed: its lines are shown unmarked, quickly`, () => {
    const big = (word: string) => Array.from({ length: 900 }, (_, i) => `Line ${i} says ${word} ${'lorem ipsum '.repeat(2)}`).join('\n');
    const started = performance.now();
    const rows = diffQuestionChange(big('old'), big('new'));
    expect(performance.now() - started).toBeLessThan(1500);
    expect(rows.length).toBe(900);
    expect(rows.every((r) => r.type === 'same' || (r.type === 'mod' && r.whole) || ((r.type === 'del' || r.type === 'add') && r.unmarked))).toBe(true);
  });

  test('the same pair is worked out once: a re-render (a pick, a keystroke) gets the same rows back', () => {
    const a = diffQuestionChange('One two three four', 'One two five four');
    expect(diffQuestionChange('One two three four', 'One two five four')).toBe(a);
  });

  test('a diff that ran out of time is not kept: the next render tries again', () => {
    // Over the edit cap (every line differs), under the size cap: the diff gives up.
    const pair = (n: number) => [Array.from({ length: 1400 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 1400 }, (_, i) => `b${i + n}`).join('\n')] as const;
    let t = 0;
    const previous = setQuestionChangeDiffClock(() => (t += 100));
    try {
      const [before, after] = pair(1);
      const first = diffQuestionChange(before, after);
      expect(first.every((r) => r.type === 'mod' && r.whole)).toBe(true);
      expect(diffQuestionChange(before, after)).not.toBe(first);
    } finally {
      setQuestionChangeDiffClock(previous);
    }
    // Given up quickly (the edit cap, not the time): the same answer every time, so it is kept.
    const [before, after] = pair(2);
    const kept = diffQuestionChange(before, after);
    expect(diffQuestionChange(before, after)).toBe(kept);
  });
});

describe('what a screen reader hears', () => {
  test('the removed and added runs, and the words without markdown', () => {
    const rows = diffQuestionChange('The version it sent. [Open it](#)', 'You are viewing the version it sent. [Open it](#)');
    expect(questionChangeMarkedRuns(rows)).toEqual({ removed: ['The'], added: ['You are viewing the'] });
    expect(questionChangePlainText('**Heading**\n- Play a sound — [when](#) asked\n- `code`')).toBe('Heading. Play a sound — when asked. code.');
  });
});
