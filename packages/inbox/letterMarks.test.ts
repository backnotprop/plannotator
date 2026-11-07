/**
 * Letter marks (approval "inbox-letter-marks", 2026-11-07): the letter rule, the colour, and how the marks live in the
 * Rows look (config.json `inboxRows`).
 * What this catches: a mark that splits a grapheme (an accent or an emoji cut in half), counts an emoji or a
 * punctuation mark as a letter, crushes two wide or joining glyphs into a 20 px tile; a colour that changes between
 * renders or with the name, or that gives ids differing only at the end one hue; marks that are on by default; a
 * picture switch or a style that does nothing when marks are off; a look whose marks a save or a read loses.
 */
import { describe, expect, test } from 'bun:test';
import { INBOX_ROWS_DEFAULT, inboxRowsCanonical, inboxRowsList, inboxRowsRead } from '@plannotator/core/inbox-types';
import { HUES, hueOf, markLetters } from './letterMarks';
import { PICTURE_MAX_BYTES, pictureFromFile } from './projectPictures';
import { LIST_LOOK_DEFAULT, LIST_LOOK_OFF, lookFromRows, lookMarks, lookWithChange, markStyleLook, marksWhatLook, rowsFromLook } from './listLook';

describe('the letters: first and last letter of the title, by grapheme', () => {
  test('Latin names give two capitals; emoji and punctuation are skipped; digits count', () => {
    expect(markLetters('Fix login redirect')).toMatchObject({ text: 'FT', count: 2 });
    expect(markLetters('🚀 Launch checklist')).toMatchObject({ text: 'LT', count: 2 });
    expect(markLetters('2fa rollout')).toMatchObject({ text: '2T', count: 2 });
    expect(markLetters('"Ship it!" (v2)')).toMatchObject({ text: 'S2', count: 2 });
  });

  test('a letter with a combining accent stays one grapheme, written either way', () => {
    // "é" decomposed (e + U+0301) and composed read the same: never a bare "E" with its accent dropped.
    expect(markLetters('été').text).toBe('ÉÉ');
    expect(markLetters('été').text).toBe('ÉÉ');
  });

  test('one letter gives one letter, not a doubled one', () => {
    expect(markLetters('x')).toMatchObject({ text: 'X', count: 1, kind: 'letters' });
  });

  test('CJK, kana, Hangul, Arabic and Devanagari give one glyph', () => {
    expect(markLetters('日本語のテスト')).toMatchObject({ text: '日', count: 1 });
    expect(markLetters('한국어 테스트')).toMatchObject({ text: '한', count: 1 });
    expect(markLetters('تجربة')).toMatchObject({ text: 'ت', count: 1 });
    // A Devanagari syllable with its vowel sign and nasal mark is one grapheme, kept whole.
    expect(markLetters('हिंदी परीक्षण').text).toBe('हिं');
    // A mix: a Latin first letter and a CJK last one is still one glyph.
    expect(markLetters('Fix 日本').count).toBe(1);
  });

  test('an emoji-only name shows its first emoji whole (a ZWJ family stays one); nothing at all shows a dot', () => {
    expect(markLetters('🔥🔥')).toMatchObject({ text: '🔥', kind: 'emoji', count: 1 });
    expect(markLetters('👨‍👩‍👧')).toMatchObject({ text: '👨‍👩‍👧', kind: 'emoji' });
    expect(markLetters('  ')).toMatchObject({ kind: 'none' });
  });
});

describe('the colour: one of eight hues from the id', () => {
  test('the same id always gives the same hue, in range', () => {
    for (const id of ['msg_01', 'prj_abc', 'msg_01M6V75H558H1WN0Z5N635T88V', '']) {
      const hue = hueOf(id);
      expect(hue).toBe(hueOf(id));
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(HUES);
    }
  });

  test('ids that differ only in their last character spread over the hues (bare FNV mod 8 gave them one)', () => {
    const hues = new Set(Array.from({ length: 16 }, (_, i) => hueOf(`msg_01M6V75H558H1WN0Z5N635T8${i.toString(16)}`)));
    expect(hues.size).toBeGreaterThanOrEqual(5);
  });
});

describe('the marks in the Rows look', () => {
  test('all off by default: Off, no picture switches, and Avatar waiting as the first style', () => {
    expect(lookMarks(LIST_LOOK_DEFAULT)).toEqual({ what: 'off', style: 'avatar', logo: false, github: false });
    expect(INBOX_ROWS_DEFAULT.some((name) => /mark|Logo|github/i.test(name))).toBe(false);
  });

  test('a style picked while marks are off turns thread marks on with it', () => {
    const look = lookWithChange(LIST_LOOK_DEFAULT, markStyleLook('dot', LIST_LOOK_DEFAULT));
    expect(lookMarks(look)).toMatchObject({ what: 'threads', style: 'dot' });
    // Already on: only the style changes.
    const both = lookWithChange(LIST_LOOK_DEFAULT, marksWhatLook('projects'));
    expect(lookMarks(lookWithChange(both, markStyleLook('inline', both)))).toMatchObject({ what: 'projects', style: 'inline' });
  });

  test('Inline and Dot are rivals: the one just picked wins', () => {
    const inline = lookWithChange({ ...LIST_LOOK_DEFAULT, marksThreads: true }, { markInline: true });
    expect(lookMarks(lookWithChange(inline, { markDot: true })).style).toBe('dot');
    expect(lookMarks(lookWithChange({ ...inline, markDot: false }, { markInline: true })).style).toBe('inline');
  });

  test('a picture switch turned on with no project marks turns them on: Off becomes Projects, Threads becomes Both', () => {
    expect(lookMarks(lookWithChange(LIST_LOOK_DEFAULT, { repoLogo: true }))).toEqual({ what: 'projects', style: 'avatar', logo: true, github: false });
    const threads = lookWithChange(LIST_LOOK_DEFAULT, marksWhatLook('threads'));
    expect(lookMarks(lookWithChange(threads, { githubPictures: true }))).toMatchObject({ what: 'both', github: true });
  });

  test('turning marks off drops the style and the pictures, so turning them on again starts as Avatar with no pictures', () => {
    let look = lookWithChange(LIST_LOOK_DEFAULT, { ...marksWhatLook('both'), markDot: true, repoLogo: true, githubPictures: true });
    look = lookWithChange(look, marksWhatLook('off'));
    expect(rowsFromLook(look)).toEqual([...INBOX_ROWS_DEFAULT]);
    expect(lookMarks(lookWithChange(look, marksWhatLook('threads')))).toEqual({ what: 'threads', style: 'avatar', logo: false, github: false });
    // Threads only keeps the style but not the project pictures.
    const kept = lookWithChange(lookWithChange(LIST_LOOK_DEFAULT, { ...marksWhatLook('both'), markInline: true, repoLogo: true }), marksWhatLook('threads'));
    expect(lookMarks(kept)).toEqual({ what: 'threads', style: 'inline', logo: false, github: false });
  });

  test('the server takes and gives back every marks choice (config.json `inboxRows`), in the same shape as the window', () => {
    const look = lookWithChange(LIST_LOOK_OFF, { ...marksWhatLook('both'), markInline: true, githubPictures: true, repoLogo: true });
    const rows = rowsFromLook(look);
    // A save (POST) is accepted as it is, and a read gives back the same look.
    expect(inboxRowsList(rows)).toEqual(rows);
    expect(lookMarks(lookFromRows(inboxRowsRead(rows)!))).toEqual({ what: 'both', style: 'inline', logo: true, github: true });
    // A hand-edited config.json in a shape the window never writes reads as the window would make it.
    expect(inboxRowsCanonical(['markInline', 'markDot', 'githubPictures', 'marksThreads'])).toEqual(['marksThreads', 'markInline']);
    expect(inboxRowsCanonical(['markDot', 'repoLogo'])).toEqual([]);
  });
});

describe('Set picture…: the picked file', () => {
  test('a file over 512 KB is refused with the approved words, never read', async () => {
    let read = false;
    const big = new Blob([new Uint8Array(PICTURE_MAX_BYTES + 1)], { type: 'image/jpeg' });
    big.arrayBuffer = async () => {
      read = true;
      return new ArrayBuffer(0);
    };
    expect(await pictureFromFile(big)).toEqual({ refused: 'Picture: at most 512 KB.' });
    expect(read).toBe(false);
  });

  test('a small one goes as a data: URL the Inbox takes', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const result = await pictureFromFile(new Blob([png], { type: 'image/png' }));
    expect(result).toEqual({ picture: `data:image/png;base64,${Buffer.from(png).toString('base64')}` });
  });
});
