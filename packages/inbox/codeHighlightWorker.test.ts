/**
 * The Inbox's highlight worker must draw a fence with the page's own characters: a fence highlighted in the
 * worker (off screen, in idle time) and one highlighted on the page (near the view) sit in the same thread,
 * and the annotation layer addresses both by text offset. These run the real @pierre/diffs highlighter on
 * the page side and the real worker (codeHighlight.worker.ts in a Bun Worker, its own realm, through
 * codeHighlightWorker.ts's protocol) on the other, and want the same markup byte for byte.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';

import { ensureHighlight, highlightToHtml } from '@plannotator/ui/utils/codeHighlight';
import { createInboxCodeHighlightWorker } from './codeHighlightWorker';
import type { FenceMarkupRequest } from './fenceMarkup';

const started: Worker[] = [];
afterAll(() => {
  for (const worker of started) worker.terminate();
});

/** codeHighlight.worker.ts, as the Inbox starts it; every request it is sent lands in `seen`. */
function realWorker(seen: FenceMarkupRequest[]): Worker {
  const worker = new Worker(new URL('./codeHighlight.worker.ts', import.meta.url).href);
  started.push(worker);
  const post = worker.postMessage.bind(worker);
  worker.postMessage = ((data: FenceMarkupRequest) => {
    seen.push(data);
    post(data);
  }) as Worker['postMessage'];
  return worker;
}

const FENCES: Array<[lang: string, code: string]> = [
  ['typescript', 'export async function load<T extends { id: string }>(ids: T[]): Promise<Map<string, T>> {\n  const out = new Map<string, T>();\n  for (const item of ids) out.set(item.id, item); // keep order\n  return out;\n}\n'],
  ['tsx', 'export const Row = ({ title }: { title: string }) => (\n  <div className="row" data-x={1 < 2 && "a & b"}>{title}</div>\n);'],
  ['python', 'def walk(tree, depth=0):\n    """Yield every node."""\n    for child in tree.children:\n        yield from walk(child, depth + 1)\n'],
  ['rust', 'fn main() {\n    let v: Vec<u8> = vec![1, 2, 3];\n    println!("{:?}", v.iter().map(|x| x * 2).collect::<Vec<_>>());\n}'],
  ['json', '{\n  "name": "heavyshop",\n  "private": true,\n  "deps": { "react": "^19.0.0" }\n}'],
  ['bash', 'set -euo pipefail\nfor f in "$@"; do\n  echo "${f%.ts}" | tr a-z A-Z > /dev/null\ndone'],
  // Grammars that embed others: the worker must have been sent those too.
  ['html', '<!doctype html>\n<style>body { color: red; }</style>\n<script>const n = 1 < 2;</script>\n<p class="x">a &amp; b</p>'],
  ['markdown', '# Title\n\nSome *words* and `code`.\n\n```typescript\nconst x: number = 1;\n```\n'],
];

const THEMES = ['pierre-dark', 'pierre-light', 'github-dark', 'kanagawa-wave'];

describe('Inbox highlight worker', () => {
  test('runs the Shiki that @pierre/diffs runs', async () => {
    const pierreEntry = Bun.resolveSync('@pierre/diffs', import.meta.dir);
    const page = (await import(Bun.resolveSync('shiki/package.json', dirname(pierreEntry)))).default.version;
    const worker = (await import(Bun.resolveSync('shiki/package.json', import.meta.dir))).default.version;
    expect(worker).toBe(page);
  });

  test('makes the markup the page makes, for every grammar and theme', async () => {
    const seen: FenceMarkupRequest[] = [];
    const worker = createInboxCodeHighlightWorker(async () => realWorker(seen));
    for (const theme of THEMES) {
      for (const [lang, code] of FENCES) {
        expect(await ensureHighlight(lang, theme)).toBe(true);
        // JavaScriptCore (Bun here, Safari) colours a grammar's first fence in a realm unlike every later one
        // (fenceMarkup.ts); a page that has drawn fences before is the one to match.
        highlightToHtml(code, lang, theme);
        const page = highlightToHtml(code, lang, theme);
        expect(page, `${lang} in ${theme} on the page`).not.toBeNull();
        expect(await worker.html(code, lang, theme), `${lang} in ${theme}`).toBe(page);
      }
    }
    // Each grammar and theme goes over once, not with every fence.
    const sentLangs = seen.flatMap((request) => (request.langs ?? []).map((lang) => lang.name));
    expect(new Set(sentLangs).size).toBe(sentLangs.length);
    const sentThemes = seen.flatMap((request) => (request.themes ?? []).map((theme) => theme.name));
    expect(new Set(sentThemes).size).toBe(sentThemes.length);
  });

  test('a fence whose grammar embeds one the page attached for other fences gets it in the worker too', async () => {
    // TypeScript is attached on the page (for other fences) but this worker is never asked for a TypeScript
    // fence: the Markdown fence's own ```typescript block still needs it there.
    const code = 'Notes:\n\n```typescript\nexport const answer: number = 42; // the one\n```\n';
    expect(await ensureHighlight('typescript', 'pierre-dark')).toBe(true);
    expect(await ensureHighlight('markdown', 'pierre-dark')).toBe(true);
    highlightToHtml(code, 'markdown', 'pierre-dark');
    const page = highlightToHtml(code, 'markdown', 'pierre-dark');
    const worker = createInboxCodeHighlightWorker(async () => realWorker([]));
    expect(await worker.html(code, 'markdown', 'pierre-dark')).toBe(page);
  });

  test('a worker that cannot start (no Worker, a CSP that refuses it) answers null, so the page highlights', async () => {
    const worker = createInboxCodeHighlightWorker(() => Promise.reject(new Error('refused')));
    expect(await ensureHighlight('typescript', 'pierre-dark')).toBe(true);
    expect(await worker.html('const x = 1;', 'typescript', 'pierre-dark')).toBeNull();
  });

  test('a worker that fails answers null for every fence it was making, and for those after', async () => {
    const target = new EventTarget();
    const broken = Object.assign(target, { postMessage() {}, terminate() {} }) as unknown as Worker;
    const worker = createInboxCodeHighlightWorker(async () => broken);
    expect(await ensureHighlight('typescript', 'pierre-dark')).toBe(true);
    const waiting = worker.html('const x = 1;', 'typescript', 'pierre-dark');
    await new Promise((resolve) => setTimeout(resolve, 0));
    target.dispatchEvent(new Event('error'));
    expect(await waiting).toBeNull();
    expect(await worker.html('const y = 2;', 'typescript', 'pierre-dark')).toBeNull();
  });
});
