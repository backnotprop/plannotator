import { afterEach, beforeEach, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '@plannotator/ui/utils/storage';
import {
  FILE_VIEW_COOKIE,
  fileViewFor,
  hashWithoutView,
  sameScreenAnyView,
  kindDefaultView,
  openingView,
  parseFileView,
  readFileViewChoice,
  writeFileViewChoice,
} from './fileView';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  setStorageBackend({
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  });
});
afterEach(() => resetStorageBackend());

const html = { kind: 'html' } as const;
const markdown = { kind: 'markdown' } as const;
const code = { kind: 'code' } as const;
const attachedImage = { kind: 'image' } as const;
const inTextImage = { kind: 'image', ref: 'shots/after.png' } as const;
const video = { kind: 'video' } as const;
const pdf = { kind: 'pdf' } as const;
const unknownKind = { kind: 'hologram' } as unknown as typeof pdf;

test("before any choice, today's rule: an HTML page and an image from a message's text open full screen, the rest side by side", () => {
  const rule = (a: Parameters<typeof kindDefaultView>[0]) => kindDefaultView(a);
  expect(rule(html)).toBe('full');
  expect(rule(inTextImage)).toBe('full');
  for (const a of [markdown, code, attachedImage, video, pdf, unknownKind]) expect(rule(a)).toBe('side');
});

test('no room for two panes (a phone, a stacked window): full screen, whatever the address or the choice says', () => {
  expect(fileViewFor(markdown, { address: 'side', choice: 'side', narrow: true })).toBe('full');
  expect(fileViewFor(html, { address: null, choice: 'side', narrow: true })).toBe('full');
  expect(fileViewFor(pdf, { address: null, choice: null, narrow: true })).toBe('full');
});

test('nothing named: the rule by kind', () => {
  expect(fileViewFor(html, { address: null, choice: null, narrow: false })).toBe('full');
  expect(fileViewFor(inTextImage, { address: null, choice: null, narrow: false })).toBe('full');
  expect(fileViewFor(attachedImage, { address: null, choice: null, narrow: false })).toBe('side');
  expect(fileViewFor(markdown, { address: null, choice: null, narrow: false })).toBe('side');
});

test('the choice applies to every kind: Side by side keeps HTML and in-text images beside the thread, Full screen takes documents full screen', () => {
  for (const attachment of [html, inTextImage, markdown, pdf]) {
    expect(fileViewFor(attachment, { address: null, choice: 'side', narrow: false })).toBe('side');
    expect(fileViewFor(attachment, { address: null, choice: 'full', narrow: false })).toBe('full');
  }
});

test('the address wins over the choice (a shared link, a reload, a tile ⋯ pick for one file)', () => {
  expect(fileViewFor(markdown, { address: 'full', choice: 'side', narrow: false })).toBe('full');
  expect(fileViewFor(html, { address: 'side', choice: 'full', narrow: false })).toBe('side');
});

test('only the two views parse; anything else in the address or the cookie counts as none', () => {
  expect(parseFileView('full')).toBe('full');
  expect(parseFileView('side')).toBe('side');
  for (const junk of [null, undefined, '', 'FULL', 'beside', 'full ', 'side;x']) expect(parseFileView(junk)).toBeNull();
});

test('the remembered choice: written, read back, forgotten; a stored value that is not a view reads as none', () => {
  expect(readFileViewChoice()).toBeNull();
  expect(openingView(html)).toBe('full');
  expect(openingView(markdown)).toBe('side');

  writeFileViewChoice('side');
  expect(store.get(FILE_VIEW_COOKIE)).toBe('side');
  expect(readFileViewChoice()).toBe('side');
  expect(openingView(html)).toBe('side');
  expect(openingView(inTextImage)).toBe('side');

  writeFileViewChoice('full');
  expect(openingView(markdown)).toBe('full');

  writeFileViewChoice(null);
  expect(store.has(FILE_VIEW_COOKIE)).toBe(false);
  expect(openingView(markdown)).toBe('side');
  expect(openingView(html)).toBe('full');

  store.set(FILE_VIEW_COOKIE, 'sideways');
  expect(readFileViewChoice()).toBeNull();
  expect(openingView(html)).toBe('full');
});

test("a linked page's Back finds its entry whatever view either hash names", () => {
  const before = '#thread=msg_1&file=att_1&linked=B.html&view=side';
  expect(hashWithoutView(before)).toBe('#thread=msg_1&file=att_1&linked=B.html');
  expect(hashWithoutView('#view=full')).toBe('');
  expect(sameScreenAnyView(before, '#thread=msg_1&file=att_1&linked=B.html&view=full')).toBe(true);
  expect(sameScreenAnyView(before, '#thread=msg_1&file=att_1&linked=B.html')).toBe(true);
  expect(sameScreenAnyView(before, '#thread=msg_1&file=att_1&linked=C.html&view=side')).toBe(false);
  expect(sameScreenAnyView(before, '#thread=msg_1&file=att_2&linked=B.html&view=side')).toBe(false);
  expect(sameScreenAnyView(before, '#thread=msg_1&file=att_1&v=sent&linked=B.html&view=side')).toBe(false);
});
