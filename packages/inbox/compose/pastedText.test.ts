/**
 * The rules of a long paste as a file (approval "inbox-paste-attachment"):
 * the 32 KB threshold in UTF-8 bytes, the file's name, and where the words go
 * back after the person edits around the tile (mapAnchor, putTextBack).
 */
import { describe, expect, test } from 'bun:test';
import { PASTE_TO_FILE_BYTES, isLongPaste, mapAnchor, pastedPreview, pastedTextName, putTextBack } from './pastedText';

describe('isLongPaste: 32 KB of UTF-8 bytes, not characters', () => {
  test('ASCII: one byte short stays text, the threshold itself is a file', () => {
    expect(isLongPaste('a'.repeat(PASTE_TO_FILE_BYTES - 1))).toBe(false);
    expect(isLongPaste('a'.repeat(PASTE_TO_FILE_BYTES))).toBe(true);
  });

  test('multi-byte text crosses the threshold with fewer characters', () => {
    // "é" is 2 bytes: 16,384 of them are 32 KB, though only half as many characters.
    expect(isLongPaste('é'.repeat(PASTE_TO_FILE_BYTES / 2))).toBe(true);
    expect(isLongPaste('é'.repeat(PASTE_TO_FILE_BYTES / 2 - 1))).toBe(false);
    // A CJK character is 3 bytes.
    expect(isLongPaste('漢'.repeat(Math.ceil(PASTE_TO_FILE_BYTES / 3)))).toBe(true);
    expect(isLongPaste('漢'.repeat(Math.floor(PASTE_TO_FILE_BYTES / 3) - 1))).toBe(false);
  });
});

test('pastedTextName: dated in local time, -2 when the name is taken in this message', () => {
  const at = new Date(2026, 10, 1, 22, 56);
  expect(pastedTextName(at, [])).toBe('pasted-text-2026-11-01-2256.txt');
  expect(pastedTextName(at, ['pasted-text-2026-11-01-2256.txt'])).toBe('pasted-text-2026-11-01-2256-2.txt');
  expect(pastedTextName(at, ['pasted-text-2026-11-01-2256.txt', 'pasted-text-2026-11-01-2256-2.txt'])).toBe('pasted-text-2026-11-01-2256-3.txt');
});

test('pastedPreview: the first line with words, its spaces collapsed', () => {
  expect(pastedPreview('\n\n   \n2026-11-01T21:10:04Z   worker   retry 3\nnext')).toBe('2026-11-01T21:10:04Z worker retry 3');
});

describe('mapAnchor: the paste goes back where it was, whatever is typed around it', () => {
  const box = 'Here is the log. The third retry.';
  const at = 'Here is the log.'.length;

  test('typing before the paste moves it by what was typed', () => {
    const after = `Hi. ${box}`;
    expect(mapAnchor(box, after, at)).toBe(at + 4);
  });

  test('typing after the paste leaves it', () => {
    expect(mapAnchor(box, `${box} Thanks.`, at)).toBe(at);
  });

  test('typing on at the caret right after the paste keeps the paste ahead of the new words', () => {
    const after = `${box.slice(0, at)} See below.${box.slice(at)}`;
    expect(mapAnchor(box, after, at)).toBe(at);
  });

  test('deleting words that hold the place puts it where they began', () => {
    const after = 'Here is the third retry.';
    expect(mapAnchor(box, after, at)).toBe('Here is the '.length);
  });

  test('deleting before it moves it back', () => {
    expect(mapAnchor(box, box.slice(5), at)).toBe(at - 5);
  });
});

test('putTextBack: the exact words at the place, the words around untouched, the caret after them', () => {
  const pasted = 'line 1\nline 2\n';
  const result = putTextBack('before|after', 'before'.length, pasted);
  expect(result.value).toBe(`before${pasted}|after`);
  expect(result.caret).toBe('before'.length + pasted.length);
  // A place past the end (the words were shortened meanwhile) is the end.
  expect(putTextBack('ab', 9, 'X')).toEqual({ value: 'abX', caret: 3 });
});
