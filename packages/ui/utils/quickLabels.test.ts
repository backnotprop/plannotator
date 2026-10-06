/**
 * Pure helpers behind Settings → Labels reordering and emoji editing (#1736).
 *
 * Failures this catches: a non-emoji (letters, several emoji) saved as a
 * label's emoji, and therefore prefixed onto every annotation the label
 * creates; a multi-code-point emoji (ZWJ sequence, flag, keycap, skin tone)
 * refused or cut apart; a move that drops or duplicates a label; the key
 * hint drifting from the digit the pickers apply.
 */
import { describe, expect, test } from 'bun:test';
import {
  emojiFromFieldInput,
  moveQuickLabel,
  parseQuickLabelEmoji,
  quickLabelIndexForDigit,
  quickLabelShortcutDigit,
} from './quickLabels';

describe('parseQuickLabelEmoji', () => {
  test('accepts exactly one emoji grapheme, including multi-code-point ones', () => {
    for (const emoji of ['🧪', '🗺️', '👨‍👩‍👧‍👦', '🇺🇸', '1️⃣', '👍🏽', '©️']) {
      expect(parseQuickLabelEmoji(emoji)).toBe(emoji);
    }
    expect(parseQuickLabelEmoji('  🔍 ')).toBe('🔍');
  });

  test('refuses empty input, text, symbols that are not emoji, and several emoji', () => {
    for (const input of ['', '   ', 'a', 'ab', '→', '🧪🔍', '🧪 🔍', '\u0007']) {
      expect(parseQuickLabelEmoji(input)).toBeNull();
    }
  });
});

describe('emojiFromFieldInput', () => {
  test('takes the new emoji whether it replaced the old one or landed beside it', () => {
    expect(emojiFromFieldInput('🔍', '🧪')).toBe('🔍');
    expect(emojiFromFieldInput('🧪🔍', '🧪')).toBe('🔍');
    expect(emojiFromFieldInput('🔍🧪', '🧪')).toBe('🔍');
  });

  test('is null while the field does not name one emoji', () => {
    expect(emojiFromFieldInput('', '🧪')).toBeNull();
    expect(emojiFromFieldInput('a🧪', '🧪')).toBeNull();
    expect(emojiFromFieldInput('🔍🎯', '🧪')).toBeNull();
  });
});

describe('moveQuickLabel', () => {
  test('moves one entry and keeps every other in order', () => {
    expect(moveQuickLabel(['a', 'b', 'c', 'd'], 2, 0)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveQuickLabel(['a', 'b', 'c', 'd'], 0, 3)).toEqual(['b', 'c', 'd', 'a']);
  });

  test('out-of-range moves return an unchanged copy', () => {
    const list = ['a', 'b'];
    const moved = moveQuickLabel(list, 0, 2);
    expect(moved).toEqual(list);
    expect(moved).not.toBe(list);
    expect(moveQuickLabel(list, -1, 0)).toEqual(list);
  });
});

test('shortcut digits: positions 0..9 map to 1..9, 0 and back; later positions have none', () => {
  for (let index = 0; index < 10; index++) {
    const digit = quickLabelShortcutDigit(index);
    expect(digit).not.toBeNull();
    expect(quickLabelIndexForDigit(Number(digit))).toBe(index);
  }
  expect(quickLabelShortcutDigit(9)).toBe('0');
  expect(quickLabelShortcutDigit(10)).toBeNull();
});
