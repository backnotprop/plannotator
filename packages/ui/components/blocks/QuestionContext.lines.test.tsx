import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { indexQuestionBlocks } from '@plannotator/core/question-block';
import { parseMarkdownToBlocks } from '../../utils/parser';
import { BlockRenderer } from '../BlockRenderer';

const hasDom = typeof document !== 'undefined';

const DOC = `:::question
Which rule should the Fristen import use?

Stopped: the import cannot continue until this rule is picked
Holds up: Fristen batch import; the October filing run
See **the spec** and \`rules.yaml\`.

- [ ] Strict
- [ ] Lenient
:::
`;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('question context lines', () => {
  test.skipIf(!hasDom)('Stopped: and Holds up: stay on their own lines; inline markdown still renders', async () => {
    const blocks = parseMarkdownToBlocks(DOC);
    const [question] = indexQuestionBlocks(blocks);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <BlockRenderer block={blocks.find((b) => b.id === question.blockId)!} question={question} questionTotal={1} />,
      ),
    );
    const context = host.querySelector<HTMLElement>('[data-question-part="context"]')!;
    const p = context.querySelector('p')!;
    expect(p.textContent).toContain('picked\nHolds up:');
    expect(p.textContent).toContain('import; the October filing run\nSee');
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    expect(css).toMatch(/\.question-context p \{ white-space: pre-line; \}/);
    expect(p.querySelector('strong')?.textContent).toBe('the spec');
    expect(p.querySelector('code')?.textContent).toBe('rules.yaml');
  });
});
