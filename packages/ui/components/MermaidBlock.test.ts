import { describe, expect, test } from 'bun:test';
import { normalizeMermaidSvgMarkup } from './mermaidSvg';

describe('normalizeMermaidSvgMarkup', () => {
  test('replaces natural max-width with max-width:none', () => {
    const input = '<svg style="max-width: 85.125px;" viewBox="0 0 346 278" width="100%"><g/></svg>';
    const expected =
      '<svg style="max-width: none" viewBox="0 0 346 278" width="100%" preserveAspectRatio="xMidYMid meet" height="100%"><g/></svg>';

    expect(normalizeMermaidSvgMarkup(input)).toBe(expected);
  });

  test('adds preserveAspectRatio when missing', () => {
    const input = '<svg viewBox="0 0 1 1"></svg>';
    const expected =
      '<svg viewBox="0 0 1 1" style="max-width: none" preserveAspectRatio="xMidYMid meet" height="100%"></svg>';

    expect(normalizeMermaidSvgMarkup(input)).toBe(expected);
  });

  test('adds height=100% when missing', () => {
    const input = '<svg viewBox="0 0 1 1" preserveAspectRatio="none"></svg>';
    const expected =
      '<svg viewBox="0 0 1 1" preserveAspectRatio="none" style="max-width: none" height="100%"></svg>';

    expect(normalizeMermaidSvgMarkup(input)).toBe(expected);
  });

  test('preserves existing preserveAspectRatio and height', () => {
    const input = '<svg viewBox="0 0 1 1" preserveAspectRatio="none" height="200"></svg>';
    const expected =
      '<svg viewBox="0 0 1 1" preserveAspectRatio="none" height="200" style="max-width: none"></svg>';

    expect(normalizeMermaidSvgMarkup(input)).toBe(expected);
  });

  test('injects style attribute when mermaid omits one', () => {
    const input = '<svg viewBox="0 0 1 1" width="100%"></svg>';
    const expected =
      '<svg viewBox="0 0 1 1" width="100%" style="max-width: none" preserveAspectRatio="xMidYMid meet" height="100%"></svg>';

    expect(normalizeMermaidSvgMarkup(input)).toBe(expected);
  });

  test('only normalizes the root <svg> tag', () => {
    const input =
      '<svg style="max-width: 100px;" viewBox="0 0 1 1"><defs><marker><svg viewBox="0 0 5 5"/></marker></defs></svg>';
    const expected =
      '<svg style="max-width: none" viewBox="0 0 1 1" preserveAspectRatio="xMidYMid meet" height="100%"><defs><marker><svg viewBox="0 0 5 5"/></marker></defs></svg>';

    expect(normalizeMermaidSvgMarkup(input)).toBe(expected);
  });

  test('leaves non-svg input unchanged', () => {
    const input = 'plain text';
    const expected = 'plain text';

    expect(normalizeMermaidSvgMarkup(input)).toBe(expected);
  });
});
