/**
 * The alert title-line grammar is a byte-level contract shared with host
 * editors (they write the bytes this parser reads), so each rule is pinned:
 * a change here must be a deliberate grammar change, not a drift.
 */
import { describe, expect, test } from 'bun:test';
import { parseAlertTitleLine } from './alertTitle';

describe('parseAlertTitleLine', () => {
  test('bold-only first line followed by an empty line is a title', () => {
    expect(parseAlertTitleLine('**Read before you deploy**\n\nThe env still names D1.')).toEqual({
      emoji: undefined,
      title: 'Read before you deploy',
      icon: undefined,
      rest: 'The env still names D1.',
    });
  });

  test('emoji, a space, then the bold title', () => {
    const r = parseAlertTitleLine('🧭 **Browser quirks**\n\nprose');
    expect(r).toEqual({ emoji: '🧭', title: 'Browser quirks', icon: undefined, rest: 'prose' });
  });

  test('bold title followed by one space and an icon comment', () => {
    const r = parseAlertTitleLine('**Browser quirks** <!-- icon: compass -->\n\nprose');
    expect(r).toEqual({ emoji: undefined, title: 'Browser quirks', icon: 'compass', rest: 'prose' });
  });

  test('an emoji alone is a title line with no text', () => {
    expect(parseAlertTitleLine('🚧\n\nbody')).toEqual({ emoji: '🚧', title: undefined, icon: undefined, rest: 'body' });
  });

  test('an icon comment alone is a title line with no text', () => {
    expect(parseAlertTitleLine('<!-- icon: compass -->\n\nbody')).toEqual({
      emoji: undefined, title: undefined, icon: 'compass', rest: 'body',
    });
  });

  test('all three parts together', () => {
    expect(parseAlertTitleLine('🧭 **T** <!-- icon: compass -->\n\nb')).toEqual({
      emoji: '🧭', title: 'T', icon: 'compass', rest: 'b',
    });
  });

  test('a title line that ends the block has an empty rest', () => {
    expect(parseAlertTitleLine('**Only a title**')).toEqual({ emoji: undefined, title: 'Only a title', icon: undefined, rest: '' });
    expect(parseAlertTitleLine('**Only a title**\n')).toEqual({ emoji: undefined, title: 'Only a title', icon: undefined, rest: '' });
  });

  test('ZWJ and modifier sequences count as one emoji', () => {
    expect(parseAlertTitleLine('👩‍💻 **Dev**\n\nx')?.emoji).toBe('👩‍💻');
    expect(parseAlertTitleLine('👍🏽 **Ok**\n\nx')?.emoji).toBe('👍🏽');
    expect(parseAlertTitleLine('🇫🇷 **Flag**\n\nx')?.emoji).toBe('🇫🇷');
    expect(parseAlertTitleLine('⚠️ **Care**\n\nx')?.emoji).toBe('⚠️');
  });

  test('trailing whitespace on the title line is tolerated', () => {
    expect(parseAlertTitleLine('**T**   \n\nb')?.title).toBe('T');
  });

  test('NOT a title: bold followed by other text', () => {
    expect(parseAlertTitleLine('**T** trailing words\n\nb')).toBeNull();
  });

  test('NOT a title: two bold runs', () => {
    expect(parseAlertTitleLine('**a** **b**\n\nb')).toBeNull();
  });

  test('NOT a title: bold with text before it', () => {
    expect(parseAlertTitleLine('Read **this**\n\nb')).toBeNull();
  });

  test('NOT a title: the next line is body, not empty', () => {
    expect(parseAlertTitleLine('**T**\nimmediately body')).toBeNull();
  });

  test('NOT a title: an ordinary paragraph or an empty body', () => {
    expect(parseAlertTitleLine('Plain sentence.\n\nmore')).toBeNull();
    expect(parseAlertTitleLine('')).toBeNull();
    expect(parseAlertTitleLine('****\n\nb')).toBeNull();
  });

  test('NOT a title: a digit or a letter is not an emoji', () => {
    expect(parseAlertTitleLine('1 **T**\n\nb')).toBeNull();
    expect(parseAlertTitleLine('x **T**\n\nb')).toBeNull();
  });

  test('NOT a title: a comment that is not an icon comment', () => {
    expect(parseAlertTitleLine('**T** <!-- note to self -->\n\nb')).toBeNull();
  });

  test('icon comment whitespace inside the delimiters is tolerated, the name is not', () => {
    expect(parseAlertTitleLine('**T** <!--icon:compass-->\n\nb')?.icon).toBe('compass');
    expect(parseAlertTitleLine('**T** <!--  icon:  a-b_c9  -->\n\nb')?.icon).toBe('a-b_c9');
    expect(parseAlertTitleLine('**T** <!-- icon: two words -->\n\nb')).toBeNull();
  });
});
