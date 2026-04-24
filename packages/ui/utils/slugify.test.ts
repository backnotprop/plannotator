import { describe, test, expect } from 'bun:test';
import { slugifyHeading, buildHeadingSlugMap } from './slugify';

describe('slugifyHeading', () => {
  test('lowercases plain text', () => {
    expect(slugifyHeading('Installation')).toBe('installation');
  });

  test('strips bold and italic markers', () => {
    expect(slugifyHeading('**Install** _now_')).toBe('install-now');
  });

  test('strips inline code backticks', () => {
    expect(slugifyHeading('Install `bun`')).toBe('install-bun');
  });

  test('strips link syntax, keeps label', () => {
    expect(slugifyHeading('See [the docs](https://example.com)')).toBe('see-the-docs');
  });

  test('strips wiki-link brackets, keeps text', () => {
    expect(slugifyHeading('[[reference]] page')).toBe('reference-page');
  });

  test('collapses runs of special characters', () => {
    expect(slugifyHeading('CI / CD & deploy')).toBe('ci-cd-deploy');
  });

  test('trims leading and trailing hyphens', () => {
    expect(slugifyHeading('   Leading and trailing   ')).toBe('leading-and-trailing');
  });

  test('preserves unicode letters', () => {
    expect(slugifyHeading('Café & résumé')).toBe('café-résumé');
  });

  test('returns empty string for empty input', () => {
    expect(slugifyHeading('')).toBe('');
  });

  test('returns empty string for all-symbol input', () => {
    expect(slugifyHeading('***')).toBe('');
  });
});

describe('buildHeadingSlugMap', () => {
  const h = (id: string, content: string) => ({ id, type: 'heading', content });

  test('assigns bare slug to the first occurrence', () => {
    const map = buildHeadingSlugMap([h('a', 'Summary')]);
    expect(map.get('a')).toBe('summary');
  });

  test('suffixes duplicates with -1, -2, ...', () => {
    const map = buildHeadingSlugMap([
      h('a', 'Summary'),
      h('b', 'Summary'),
      h('c', 'Summary'),
    ]);
    expect(map.get('a')).toBe('summary');
    expect(map.get('b')).toBe('summary-1');
    expect(map.get('c')).toBe('summary-2');
  });

  test('skips non-heading blocks', () => {
    const map = buildHeadingSlugMap([
      h('a', 'Intro'),
      { id: 'b', type: 'paragraph', content: 'Intro' },
      h('c', 'Intro'),
    ]);
    expect(map.get('a')).toBe('intro');
    expect(map.get('b')).toBeUndefined();
    expect(map.get('c')).toBe('intro-1');
  });

  test('skips headings that slugify to empty', () => {
    const map = buildHeadingSlugMap([h('a', '***')]);
    expect(map.has('a')).toBe(false);
  });
});
