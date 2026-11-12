import { expect, test } from 'bun:test';
import { codeParts, latestCardFace, releasesBetween, releaseWords, tldrDot } from './whatsNew';

const row = (over: Partial<Parameters<typeof releaseWords>[0]> = {}) => ({ tldr: [], listed: null, sentence: null, ...over });

test('a row says its TL;DR, else its release-list line, else its first sentence, else "No summary"', () => {
  const tldr = [{ label: 'New', text: 'A' }];
  const listed = { text: 'From the table', in: '0.28.53' };
  expect(releaseWords(row({ tldr, listed, sentence: 'First.' }))).toEqual({ kind: 'tldr', lines: tldr });
  expect(releaseWords(row({ listed, sentence: 'First.' }))).toEqual({ kind: 'listed', text: 'From the table', from: '0.28.53' });
  expect(releaseWords(row({ sentence: 'First.' }))).toEqual({ kind: 'sentence', text: 'First.' });
  expect(releaseWords(row())).toEqual({ kind: 'none' });
  expect(releaseWords(row({ tldr: [{ label: 'New', text: ' ' }], listed: { text: ' ', in: '0.28.53' }, sentence: '' }))).toEqual({ kind: 'none' });
});

test('the Latest card is compact while the latest release is open, full otherwise', () => {
  expect(latestCardFace('0.28.53', '0.28.53')).toBe('compact');
  expect(latestCardFace('0.28.50', '0.28.53')).toBe('full');
  expect(latestCardFace(null, '0.28.53')).toBe('full');
});

test('each label has its dot; any other label has none', () => {
  expect(['New', 'Changed', 'Fixed', 'Removed', 'Off by default'].map(tldrDot)).toEqual(['new', 'changed', 'fixed', 'removed', 'off']);
  expect(tldrDot('off by default')).toBe('off');
  expect(tldrDot('Security')).toBeNull();
  expect(tldrDot('')).toBeNull();
});

test('the releases in between: strictly between, each once', () => {
  expect(releasesBetween('0.28.50', '0.28.53', ['0.28.53', '0.28.52', '0.28.51', '0.28.51', '0.28.50', '0.28.9'])).toBe(2);
  expect(releasesBetween('0.28.53', '0.28.53', ['0.28.53'])).toBe(0);
  expect(releasesBetween('0.28.53', '0.28.101', ['0.28.100', '0.28.54'])).toBe(2);
});

test('`code` in a TL;DR line comes apart; an unpaired backtick is text', () => {
  expect(codeParts('Removed `X_Y`: Ask AI is on')).toEqual([
    { code: false, text: 'Removed ' },
    { code: true, text: 'X_Y' },
    { code: false, text: ': Ask AI is on' },
  ]);
  expect(codeParts('It`s fine')).toEqual([{ code: false, text: 'Its fine' }]);
});
