/**
 * Paste to attach (compose/paste.ts): which pastes carry files, which leave
 * the browser's text paste alone, and the name a clipboard image gets.
 */
import { describe, expect, test } from 'bun:test';
import { chosenFileNames, clipboardFiles, clipboardHasText, pastedFileName, pastedImageOwnLink, pastedFiles, pasteStamp } from './compose/paste';

const at = new Date(2026, 9, 16, 9, 12, 40);
const file = (name: string, type: string) => new File(['x'], name, { type });
const data = (items: { kind: string; type: string; file?: File }[], text = '', html = '') =>
  ({
    items: items.map((item) => ({ kind: item.kind, type: item.type, getAsFile: () => item.file ?? null })),
    files: items.flatMap((item) => (item.file ? [item.file] : [])),
    types: items.map((item) => (item.kind === 'file' ? 'Files' : item.type)),
    getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : ''),
  }) as unknown as DataTransfer;

describe('a pasted file name', () => {
  test('a clipboard image with a generic name or none gets a dated one, in local time', () => {
    expect(pasteStamp(at)).toBe('2026-10-16-0912');
    for (const name of ['image.png', 'Pasted Graphic.png', 'Pasted Graphic 3.png', 'blob', '', 'clipboard-image.png']) {
      expect(pastedFileName(file(name, 'image/png'), at, new Set())).toBe('pasted-image-2026-10-16-0912.png');
    }
    expect(pastedFileName(file('image.jpeg', 'image/jpeg'), at, new Set())).toBe('pasted-image-2026-10-16-0912.jpg');
    expect(pastedFileName(file('', 'application/pdf'), at, new Set())).toBe('pasted-file-2026-10-16-0912.bin');
  });

  test('a real name is kept; a taken dated name gets -2, -3', () => {
    expect(pastedFileName(file('design.png', 'image/png'), at, new Set())).toBe('design.png');
    const taken = new Set(['pasted-image-2026-10-16-0912.png']);
    expect(pastedFileName(file('image.png', 'image/png'), at, taken)).toBe('pasted-image-2026-10-16-0912-2.png');
    taken.add('pasted-image-2026-10-16-0912-2.png');
    expect(pastedFileName(file('Pasted Graphic.png', 'image/png'), at, taken)).toBe('pasted-image-2026-10-16-0912-3.png');
    // The renamed File itself is proved in the window (pasteFiles.test.tsx): bun's test File keeps a part's name.
    expect(pastedFiles(data([{ kind: 'file', type: 'image/png', file: file('image.png', 'image/png') }]), taken, at)).toHaveLength(1);
  });
});

describe('what a paste carries', () => {
  test('text with an unnamed picture (a cell copied in Excel, Numbers or Pages) attaches nothing; a named file beside its name attaches', () => {
    const picture = { kind: 'file', type: 'image/png', file: file('image.png', 'image/png') };
    const text = { kind: 'string', type: 'text/plain' };
    expect(pastedFiles(data([text, picture], 'Q3\t1,204\t+8%'), [], at)).toEqual([]);
    expect(pastedFiles(data([text, { ...picture, file: file('Pasted Graphic 2.png', 'image/png') }], 'Revenue'), [], at)).toEqual([]);
    const fromFinder = file('chart.png', 'image/png');
    expect(pastedFiles(data([text, { kind: 'file', type: 'image/png', file: fromFinder }], 'chart.png'), [], at)).toEqual([fromFinder]);
    // A screenshot, and Chrome's "Copy image" (HTML, no plain text): no plain text, so the picture attaches.
    expect(pastedFiles(data([picture]), [], at)).toHaveLength(1);
    expect(pastedFiles(data([{ kind: 'string', type: 'text/html' }, picture], ''), [], at)).toHaveLength(1);
    expect(pastedFiles(data([text, picture], '   '), [], at)).toHaveLength(1);
  });

  test('text alone carries no files and has text: the browser pastes it', () => {
    const plain = data([{ kind: 'string', type: 'text/plain' }]);
    expect(clipboardFiles(plain)).toEqual([]);
    expect(pastedFiles(plain, [])).toEqual([]);
    expect(clipboardHasText(plain)).toBe(true);
  });

  test('a screenshot carries a file and no text; an image from a page carries HTML beside it', () => {
    const shot = data([{ kind: 'file', type: 'image/png', file: file('image.png', 'image/png') }]);
    expect(clipboardFiles(shot)).toHaveLength(1);
    expect(clipboardHasText(shot)).toBe(false);
    const fromPage = data([{ kind: 'string', type: 'text/html' }, { kind: 'file', type: 'image/png', file: file('image.png', 'image/png') }]);
    expect(clipboardFiles(fromPage)).toHaveLength(1);
    expect(clipboardHasText(fromPage)).toBe(true);
    expect(clipboardHasText(null)).toBe(false);
  });

  test('an image copied from a page attaches on a phone only when the HTML is an <img> whose src is the plain-text link', () => {
    const picture = { kind: 'file', type: 'image/png', file: file('image.png', 'image/png') };
    const text = { kind: 'string', type: 'text/plain' };
    const html = { kind: 'string', type: 'text/html' };
    const url = 'https://example.com/board/header.png?w=2&h=1';
    const copied = data([text, html, picture], ` ${url}\n`, '<meta charset="utf-8"><img src="https://example.com/board/header.png?w=2&amp;h=1" alt="">');
    expect(pastedImageOwnLink(copied, true)).toBe(true);
    expect(pastedFiles(copied, [], at, { phone: true })).toHaveLength(1);
    // A desktop keeps today's rule: text with an unnamed picture is text.
    expect(pastedImageOwnLink(copied, false)).toBe(false);
    expect(pastedFiles(copied, [], at)).toEqual([]);
    // An Excel or Numbers cell whose value is a URL: its text, an HTML table and a picture of the cell. Text, on both.
    const cell = data([text, html, picture], url, `<table><tr><td>${url.replace('&', '&amp;')}</td></tr></table>`);
    expect(pastedFiles(cell, [], at, { phone: true })).toEqual([]);
    expect(pastedFiles(cell, [], at)).toEqual([]);
    // A link with no HTML, an <img> of another address, a sentence, a file:// link: text.
    expect(pastedImageOwnLink(data([text, picture], url), true)).toBe(false);
    expect(pastedImageOwnLink(data([text, html, picture], url, '<img src="https://example.com/other.png">'), true)).toBe(false);
    expect(pastedImageOwnLink(data([text, html, picture], `See ${url}`, `<img src="${url}">`), true)).toBe(false);
    expect(pastedImageOwnLink(data([text, html, picture], 'file:///tmp/a.png', '<img src="file:///tmp/a.png">'), true)).toBe(false);
    expect(pastedImageOwnLink(null, true)).toBe(false);
  });
});

describe('files chosen with the attach button', () => {
  test('a photo the library names image.jpg gets a dated name, a second one kept apart; a real name is kept', () => {
    const named = chosenFileNames([file('image.jpg', 'image/jpeg'), file('image.jpg', 'image/jpeg'), file('IMG_2041.HEIC', 'image/heic')], ['pasted-image-2026-10-16-0912.jpg'], at);
    expect(named).toEqual(['pasted-image-2026-10-16-0912-2.jpg', 'pasted-image-2026-10-16-0912-3.jpg', 'IMG_2041.HEIC']);
  });
});
