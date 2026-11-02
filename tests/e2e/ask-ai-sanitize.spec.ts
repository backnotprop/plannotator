/**
 * Ask AI answers through the real DOMPurify in a real browser (happy-dom
 * cannot host DOMPurify, so aiChatFormat.test.ts cannot prove this): a class,
 * data-* and aria-* on raw HTML do not survive; a table keeps its column
 * alignment and a link keeps its href; a badly nested answer falls back to
 * plain text instead of throwing. Bundles renderChatMarkdown for the browser
 * and loads it into a blank page; no server, no binary.
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const module = resolve(__dirname, '../../packages/ui/utils/aiChatFormat.ts');

test('Ask AI output is sanitized and never throws', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'ask-ai-'));
  const entry = join(dir, 'entry.ts');
  const out = join(dir, 'bundle.js');
  // A React element's props hold the sanitized markup, or the fallback text.
  writeFileSync(entry, `import { renderChatMarkdown } from ${JSON.stringify(module)};
(window as any).render = (t: string) => { const p = (renderChatMarkdown(t) as any).props; return { html: p.dangerouslySetInnerHTML?.__html ?? null, text: p.children ?? null }; };`);
  execFileSync('bun', ['build', entry, '--target=browser', '--define', 'process.env.NODE_ENV="production"', '--outfile', out]);

  await page.setContent('<body></body>');
  await page.addScriptTag({ path: out });
  const render = (t: string) => page.evaluate((s) => (window as any).render(s) as { html: string | null; text: string | null }, t);

  const raw = await render('<p class="fixed inset-0" data-x="1" aria-label="y">kept</p>\n\n<a href="https://docs.example.test/a" class="z-50" data-k="v" aria-hidden="true">link</a>');
  expect(raw.html).toContain('kept');
  expect(raw.html).toContain('href="https://docs.example.test/a"');
  expect(raw.html).not.toMatch(/class=|data-|aria-/);

  const table = await render('| A | B | C |\n|:--|--:|:-:|\n| 1 | 2 | 3 |');
  for (const a of ['left', 'right', 'center']) expect(table.html).toContain(`align="${a}"`);

  const nested = await render(`${'>'.repeat(20000)} deep\n<script>1</script>`);
  expect(nested.html).toBeNull();
  expect(nested.text).toContain('deep\n<script>1</script>');
});
