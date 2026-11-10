import { describe, expect, test } from 'bun:test';
import { READ_PLUGIN_UPDATE_QUERY } from './src/lib/plugin-update';
import { readFileSync } from 'node:fs';

// The install script opens https://plannotator.ai/plugin-update/?state=…&from=…&to=…
// The page reads that query in the browser with this exact source text.
const read = new Function(`return (${READ_PLUGIN_UPDATE_QUERY});`)() as (search: string) => {
  state: string;
  from: string | null;
  to: string | null;
};

describe('plugin-update page query', () => {
  test('picks the variant the installer asks for, and the general one otherwise', () => {
    expect(read('?state=reload').state).toBe('reload');
    expect(read('?state=manual').state).toBe('manual');
    expect(read('').state).toBe('general');
    expect(read('?state=<b>x</b>').state).toBe('general');
    expect(read('?state=Manual').state).toBe('general');
  });

  test('shows versions only when they are digits and dots', () => {
    expect(read('?state=manual&from=0.28.43&to=0.28.61')).toEqual({ state: 'manual', from: '0.28.43', to: '0.28.61' });
    for (const bad of ['<img src=x onerror=alert(1)>', '0.28.43<script>', 'v0.28.43', '0.28.43 ', '1', '0..1', '0.28.43-beta', '1.2.3.4.5', `${'9'.repeat(7)}.1`]) {
      expect(read(`?state=reload&from=${encodeURIComponent(bad)}&to=0.28.61`).from).toBeNull();
    }
  });
});

describe('plugin-update page route', () => {
  // The installer may open the page with or without the trailing slash.
  const handlerSource = readFileSync(new URL('./cloudfront/url-rewrite.js', import.meta.url), 'utf8');
  const handler = new Function(`${handlerSource}; return handler;`)() as (event: { request: { uri: string } }) => { uri?: string };
  test('resolves with and without a trailing slash', () => {
    expect(handler({ request: { uri: '/plugin-update' } }).uri).toBe('/plugin-update/index.html');
    expect(handler({ request: { uri: '/plugin-update/' } }).uri).toBe('/plugin-update/index.html');
  });
});
