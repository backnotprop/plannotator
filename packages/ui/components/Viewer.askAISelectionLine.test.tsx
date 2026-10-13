/**
 * Ask AI from a text selection names the selection's source line (#1731),
 * driven through the REAL Viewer and web-highlighter (DOM-gated, DOM_TESTS=1).
 *
 * Failure to catch: the phrase occurs twice in the document and the question
 * reaches the agent (side chat, Ask this session, or the agent terminal, which
 * all send `buildDefaultPrompt`'s output) with only the path, or with the line
 * of the OTHER occurrence, so the agent cannot tell which one the reviewer
 * means.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CommentAskAIContext } from './CommentPopover';

const hasDom = typeof document !== 'undefined';
// Viewer, the parser and web-highlighter read the DOM at module scope; load
// lazily so this file stays inert in the DOM-less default `bun test` run.
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;
const chatModule = hasDom ? await import('../hooks/useAIChat') : null;

const PHRASE = 'retry the job';
// The phrase sits on line 3 and again on line 9.
const MARKDOWN = [
  '# Rollout',
  '',
  `First we ${PHRASE} once.`,
  '',
  '## Recovery',
  '',
  'Some unrelated paragraph.',
  '',
  `Then we ${PHRASE} again.`,
  '',
].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  }
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

async function mountViewer(asked: CommentAskAIContext[]): Promise<HTMLElement> {
  const Viewer = viewerModule!.Viewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parserModule!.parseMarkdownToBlocks(MARKDOWN)}
        markdown={MARKDOWN}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="comment"
        inputMethod="drag"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        sourceInfo="/docs/rollout.md"
        onAskAI={(_question, context) => {
          asked.push(context);
          return true;
        }}
      />,
    );
  });
  await settle();
  return host!;
}

/** Select PHRASE inside the block whose text includes `marker`, then end the
 *  pointer gesture the way the highlighter listens for it. */
async function selectPhraseIn(container: HTMLElement, marker: string): Promise<void> {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent?.includes(marker) && n.textContent.includes(PHRASE)) {
      node = n as Text;
      break;
    }
  }
  if (!node) throw new Error(`text node with "${marker}" not found`);
  const start = node.textContent!.indexOf(PHRASE);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + PHRASE.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const article = node.parentElement!.closest('article') ?? container;
  await act(async () => {
    article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function ask(question: string): Promise<void> {
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!textarea) throw new Error('composer did not open');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set;
  await act(async () => {
    setter?.call(textarea, question);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = [...document.querySelectorAll<HTMLButtonElement>('[data-comment-popover] button')]
    .find((b) => b.textContent?.trim() === 'Ask AI');
  if (!button) throw new Error('Ask AI button missing');
  await act(async () => { button.click(); });
  await settle();
}

describe.if(hasDom)('Viewer: Ask AI from a text selection names its line (#1731)', () => {
  test('the second occurrence of a repeated phrase names line 9, not line 3', async () => {
    const asked: CommentAskAIContext[] = [];
    const container = await mountViewer(asked);
    await selectPhraseIn(container, 'Then we');
    await ask('Why again?');

    expect(asked).toHaveLength(1);
    const context = asked[0]!;
    expect(context.text).toBe(PHRASE);
    expect(context.lineStart).toBe(9);
    expect(context.lineEnd).toBe(9);

    const prompt = chatModule!.buildDefaultPrompt({ prompt: 'Why again?', scope: context });
    expect(prompt).toContain('Source: /docs/rollout.md, line 9\n');
    expect(prompt).not.toContain('line 3');
  });

  test('the first occurrence names line 3', async () => {
    const asked: CommentAskAIContext[] = [];
    const container = await mountViewer(asked);
    await selectPhraseIn(container, 'First we');
    await ask('Why once?');

    expect(asked).toHaveLength(1);
    expect(asked[0]!.lineStart).toBe(3);
    expect(asked[0]!.lineEnd).toBe(3);
  });
});
