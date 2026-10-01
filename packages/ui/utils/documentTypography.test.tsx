import { expect, test } from 'bun:test';
import { documentTypographyStyle } from './documentTypography';

test('document typography is opt-in and scales from the 15px baseline', () => {
  expect(documentTypographyStyle(true, 'Georgia', 24)).toEqual({ '--plannotator-document-font-family': '"Georgia", var(--font-sans, sans-serif)', '--plannotator-document-font-scale': 1.6 });
  expect(documentTypographyStyle(false, 'Georgia', 24)).toBeUndefined();
  expect(documentTypographyStyle(true, '', null)).toBeUndefined();
});

test('custom font names are quoted with a theme fallback', () => {
  expect(documentTypographyStyle(true, ' Georgia ', null)?.['--plannotator-document-font-family']).toBe('"Georgia", var(--font-sans, sans-serif)');
  expect(documentTypographyStyle(true, 'Font "Name"', null)?.['--plannotator-document-font-family']).toBe('"Font \\"Name\\"", var(--font-sans, sans-serif)');
});
