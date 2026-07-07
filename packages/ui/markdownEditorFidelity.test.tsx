/**
 * Fidelity corpus test for the markdown edit mode (atomic-editor / CM6).
 *
 * The edit-mode contract: loading a document into the editor and reading it
 * back is BYTE-IDENTICAL — rendering is decoration-only, the text is the
 * source of truth. If this ever fails, the diff-of-edits feedback sent to
 * agents would contain phantom changes the user never made.
 *
 * Two layers:
 *  1. Synthetic PFM fixtures (in-repo, deterministic, run everywhere).
 *  2. A runtime sample of real plans from ~/.plannotator/history — skipped
 *     when the directory doesn't exist (CI). Real user content deliberately
 *     stays OUT of the repo.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test markdownEditorFidelity
 */
import { describe, test, expect } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
} from '@plannotator/atomic-editor';

const hasDom = typeof document !== 'undefined';
const CORPUS_DIR = join(homedir(), '.plannotator', 'history');
const CORPUS_SAMPLE_SIZE = 150;
const MAX_FILE_BYTES = 64 * 1024;

const FIXTURES: Record<string, string> = {
  'pfm-kitchen-sink': `---
title: Spike Plan
tags: [a, b]
---

# Heading *with emphasis*

Some text with **bold**, _underscore italic_, \`src/foo.ts:10-20\`, [[wiki-link]], #fff and #123.

:::note
A directive callout with ***nested* bold**.
:::

> [!WARNING]
> Alert content with a [link](https://example.com/path_(parens)).

* star bullet (not dash)
* second
  1. nested ordered
  2. with trailing spaces

| Col | Col2 |
| --- | ---- |
| a\\|b | *md* |

\`\`\`\`md
\`\`\`ts
nested fence
\`\`\`
\`\`\`\`

- [ ] task open
- [x] task done

text with trailing whitespace
and a hard\\
break — em…dash "quotes"
`,
  'mermaid-and-code': `# Diagram plan

\`\`\`mermaid
graph TD
  A[Start] --> B{Decision}
  B -->|yes| C[Done]
\`\`\`

\`\`\`unknown-language
weird   spacing	and	tabs
\`\`\`

\`\`\`ts
const x: Record<string, number> = { 'a-b': 1 };
\`\`\`

Inline \`code with *asterisks*\` and an autolink https://example.com/a_(b) plus <https://angle.example>.
`,
  'whitespace-edges': `# Edge cases

paragraph with two trailing spaces
then a line

\t- tab-indented bullet
   - three-space bullet

> quote line one
> quote line two


triple blank lines above, none below`,
};

async function mountAndRead(markdown: string): Promise<string> {
  const host = document.createElement('div');
  host.style.width = '600px';
  host.style.height = '400px';
  document.body.appendChild(host);
  const handleRef: { current: AtomicCodeMirrorEditorHandle | null } = { current: null };
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <AtomicCodeMirrorEditor markdownSource={markdown} editorHandleRef={handleRef} />,
    );
  });
  const out = handleRef.current?.getMarkdown() ?? '<<no handle>>';
  await act(async () => {
    root.unmount();
  });
  host.remove();
  return out;
}

/** Deterministic sample: stable hash over the path, take the N smallest. */
function sampleCorpus(): string[] {
  if (!existsSync(CORPUS_DIR)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (entry.endsWith('.md') && st.size > 0 && st.size <= MAX_FILE_BYTES) files.push(full);
      } catch {
        /* unreadable entry — skip */
      }
    }
  };
  walk(CORPUS_DIR);

  const hash = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  return files
    .map((f) => ({ f, h: hash(f) }))
    .sort((a, b) => a.h - b.h)
    .slice(0, CORPUS_SAMPLE_SIZE)
    .map((x) => x.f);
}

describe('markdown edit mode fidelity', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    test.skipIf(!hasDom)(`fixture ${name}: load → getMarkdown is byte-identical`, async () => {
      const out = await mountAndRead(fixture);
      expect(out).toBe(fixture);
    });
  }

  test.skipIf(!hasDom || !existsSync(CORPUS_DIR))(
    `corpus sample (${CORPUS_SAMPLE_SIZE} real plans): load → getMarkdown is byte-identical`,
    async () => {
      const sample = sampleCorpus();
      expect(sample.length).toBeGreaterThan(0);

      const failures: string[] = [];
      let tested = 0;
      let skippedCrlf = 0;
      for (const file of sample) {
        const content = readFileSync(file, 'utf8');
        // CM6's Text model joins lines with \n; CRLF input cannot round-trip.
        // The corpus is verified \r-free today — guard rather than fail noisily.
        if (content.includes('\r')) {
          skippedCrlf++;
          continue;
        }
        const out = await mountAndRead(content);
        tested++;
        if (out !== content) failures.push(file);
      }

      console.log(`[fidelity] tested=${tested} skippedCrlf=${skippedCrlf} failures=${failures.length}`);
      expect(failures).toEqual([]);
    },
    120_000,
  );
});
