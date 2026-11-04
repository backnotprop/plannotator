/**
 * Shape's `data-code` reader against the board itself, in a real browser:
 * every code that survives Shape's own sanitizer (sanitizeShapeHtml: DOMPurify
 * on DOMParser, scripting off) and is drawn by the board's innerHTML in a
 * shadow root (scripting on) must be one the reader (core's
 * shapeHtmlDataCodes) found in the source. The checks that use the reader
 * (Shape's unreadable-code problem, a Show me drawing's or a drawn overview's
 * files) refuse what they read; a code they never read would reach the board
 * unchecked. Every payload of the reviews, then random markup made of the
 * pieces that move a parser. No server, no binary: the two functions are
 * bundled for the page.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { DATA_CODE_BYPASSES, htmlSoup, seededRandom } from '../helpers/html-soup';

const repo = resolve(__dirname, '../..');

function bundle(): string {
  const scratch = mkdtempSync(join(tmpdir(), 'shape-reader-'));
  try {
    const entry = join(scratch, 'entry.ts');
    writeFileSync(
      entry,
      [
        `import { sanitizeShapeHtml } from ${JSON.stringify(join(repo, 'packages/ui/components/shape/ShapeDrawn'))};`,
        `import { shapeHtmlDataCodes } from ${JSON.stringify(join(repo, 'packages/core/shape'))};`,
        'Object.assign(window, { sanitizeShapeHtml, shapeHtmlDataCodes });',
      ].join('\n'),
    );
    const out = join(scratch, 'out.js');
    const built = spawnSync('bun', ['build', entry, '--target=browser', '--outfile', out], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
    expect(built.status, built.stderr).toBe(0);
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('every data-code the board draws after sanitizing is one the reader read', async ({ page }) => {
  const script = bundle();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: script });

  const next = seededRandom(0xb0a2d);
  let id = 0;
  const code = () => `c${id++}`;
  const cases = [...DATA_CODE_BYPASSES];
  for (let k = 0; k < 5_000; k++) cases.push(htmlSoup(next, code));

  const result = await page.evaluate((sources) => {
    const w = window as unknown as { sanitizeShapeHtml: (html: string) => string; shapeHtmlDataCodes: (html: string) => string[] };
    // The sanitizer refuses to run (empty output) if it failed its own proof: that must not pass as "nothing drawn".
    if (!w.sanitizeShapeHtml('<div data-mark="a" data-code="a.ts#L1">kept</div>').includes('kept')) return { sanitizerWorks: false, drawn: 0, missed: [] as string[] };
    const missed: string[] = [];
    let drawn = 0;
    for (const source of sources) {
      const host = document.createElement('div');
      document.body.append(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<div class="board">${w.sanitizeShapeHtml(source)}</div>`;
      // DOMPurify trims every attribute value (String.prototype.trim, so U+00A0 too); the checks trim the reader's.
      const read = new Set(w.shapeHtmlDataCodes(source).map((value) => value.trim()));
      for (const el of root.querySelectorAll('[data-code]')) {
        drawn++;
        if (!read.has((el.getAttribute('data-code') ?? '').trim())) missed.push(source);
      }
      host.remove();
    }
    return { sanitizerWorks: true, drawn, missed };
  }, cases);

  expect(result.sanitizerWorks).toBe(true);
  expect(result.missed.slice(0, 5)).toEqual([]);
  // The corpus draws codes at all (the reviews' payloads each draw one).
  expect(result.drawn).toBeGreaterThan(DATA_CODE_BYPASSES.length);
});
