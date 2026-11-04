/**
 * A thread is drawn once its code and math can be drawn finished (#2593).
 *
 * The window's scripts are code-split (build/pack-inbox.ts): Pierre's
 * highlighter, each Shiki grammar and KaTeX are chunks the Inbox serves on
 * first use. Inlined, they were there before the first thread opened, so a
 * fence painted highlighted and math painted typeset at once. Split, ui's
 * CodeBlock and math components would paint plain code or TeX source first and
 * swap the finished markup in when the chunk lands. So a thread read waits for
 * what its messages need, then draws: no plain frame, as before. A thread with
 * no code or math is not held up, and a language or KaTeX already loaded costs
 * nothing.
 */

import type { InboxThread } from '@plannotator/core/inbox-types';
import type { Block } from '@plannotator/ui/types';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { ensureHighlight } from '@plannotator/ui/utils/codeHighlight';
import { getMathRenderer, loadMathRenderer } from '@plannotator/ui/utils/math';
import { isGraphvizLanguage, isMermaidLanguage } from '@plannotator/ui/components/diagramLanguages';
import { resolveFenceTheme } from '@plannotator/ui/utils/syntaxTheme';

/**
 * A safety cap, never reached in use (a grammar arrives in a few ms over loopback, ~100 ms over a tailnet):
 * a chunk that never answers must not keep a thread closed. Past it the thread draws, and ui swaps the
 * finished markup in when the chunk lands.
 */
export const DRAW_READY_CAP_MS = 4000;

/** The fence theme the window draws in now, kept by WarmCodeHighlight (inside the ThemeProvider). */
let theme = resolveFenceTheme('plannotator', 'dark');
export function setThreadFenceTheme(next: string): void {
  theme = next;
}

/** `$…$`, `\(…\)`, `\[…\]` or `$$`: a body that may hold math (over-matching only loads KaTeX once). */
const MATH_HINT = /\$[^\s$][^$\n]*\$|\$\$|\\\(|\\\[/;
const FENCE_HINT = /```|~~~/;

/** What a body's blocks need before they draw finished: the fence languages ui highlights, and KaTeX. */
function needs(body: string, langs: Set<string>): boolean {
  let math = false;
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.type === 'code') {
        // Diagrams draw through their own runtime, never as a highlighted fence.
        if (block.language && !isMermaidLanguage(block.language) && !isGraphvizLanguage(block.language)) langs.add(block.language);
      } else if (block.type === 'math') math = true;
      else if (block.type === 'directive') walk(parseMarkdownToBlocks(block.content, { frontmatter: false }));
      else if (block.type !== 'html' && MATH_HINT.test(block.content)) math = true;
    }
  };
  walk(parseMarkdownToBlocks(body, { frontmatter: false }));
  return math;
}

/** Resolves when every fence of the thread can paint highlighted and its math typeset (or at the cap). Never rejects. */
export function threadDrawReady(thread: InboxThread): Promise<void> {
  const langs = new Set<string>();
  let math = false;
  for (const message of thread.messages) {
    const body = message.body ?? '';
    if (!FENCE_HINT.test(body) && !MATH_HINT.test(body)) continue;
    if (needs(body, langs)) math = true;
  }
  const waits: Promise<unknown>[] = [...langs].map((lang) => ensureHighlight(lang, theme));
  if (math && !getMathRenderer()) waits.push(loadMathRenderer().catch(() => undefined));
  if (waits.length === 0) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => (timer = setTimeout(resolve, DRAW_READY_CAP_MS)));
  return Promise.race([Promise.all(waits).then(() => undefined), cap]).finally(() => clearTimeout(timer));
}
