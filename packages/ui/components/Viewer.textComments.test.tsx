/**
 * `Viewer` `textComments` with `answerOnly` (a host that shows a message whose
 * words take comments, the Plannotator Inbox), driven through the REAL Viewer
 * and web-highlighter (DOM-gated, DOM_TESTS=1).
 *
 * Failures to catch: the seam leaks into plain `answerOnly` (a selection
 * there opens a toolbar), the toolbar offers Delete or the label picker on a
 * surface that only takes comments, the words of a question card open a
 * toolbar, or `readOnly` stops winning.
 */
import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

const MARKDOWN = [
  'The backoff is two, four and eight seconds.',
  '',
  ':::question',
  'Which rounding rule wins?',
  '',
  '- [ ] Half up',
  '- [ ] Half even',
  ':::',
  '',
  ':::action',
  'Publish the tarball',
  ':::',
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

async function mount(props: { textComments?: boolean; readOnly?: boolean; renderDirectiveBlock?: (block: { directiveKind?: string }) => React.ReactNode | undefined }): Promise<HTMLElement> {
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
        mode="selection"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        answerOnly
        onAnswerQuestion={() => {}}
        {...props}
      />,
    );
  });
  await settle();
  return host!;
}

/** Select `phrase` (inside `scope`) and let the viewer hear the pointer go up. */
async function select(scope: HTMLElement, phrase: string) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(phrase)) node = n as Text;
  const at = node!.textContent!.indexOf(phrase);
  const range = document.createRange();
  range.setStart(node!, at);
  range.setEnd(node!, at + phrase.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    (node!.parentElement!.closest('article') ?? scope).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const toolbarNames = () => [...document.querySelectorAll<HTMLButtonElement>('.annotation-toolbar button')].map((b) => b.getAttribute('aria-label') ?? b.title);

test.skipIf(!hasDom)('answerOnly alone: a selection opens no toolbar', async () => {
  const el = await mount({});
  await select(el, 'two, four and eight');
  expect(toolbarNames()).toEqual([]);
});

test.skipIf(!hasDom)('with textComments: the comment-only toolbar (Comment and 👍, no Delete, no label picker); a question card stays out', async () => {
  const el = await mount({ textComments: true });
  await select(el, 'two, four and eight');
  const names = toolbarNames();
  expect(names).toContain('Comment');
  expect(names).toContain('Looks good');
  expect(names).not.toContain('Delete');
  expect(names).not.toContain('Quick label');
  // Still answer-only: no Global comment or Copy.
  expect([...el.querySelectorAll('button')].some((b) => /Global comment|Copy/.test(b.textContent ?? ''))).toBe(false);

  await act(async () => document.querySelector<HTMLButtonElement>('.annotation-toolbar button[aria-label="Cancel"], .annotation-toolbar button[title="Cancel"]')?.click());
  await settle();
  const card = el.querySelector<HTMLElement>('[data-question-key]')!;
  expect(card.closest('.annotation-exclude')).not.toBeNull();
  await select(card, 'Which rounding');
  expect(toolbarNames()).toEqual([]);
});

/** A host's card in place of a `:::action` block (the Inbox's action items): its words are the person's to select and copy. */
const hostCard = (block: { directiveKind?: string }) =>
  block.directiveKind === 'action' ? <p data-host-card="">Run npm publish dist/core.tgz in the repo root</p> : undefined;

test.skipIf(!hasDom)('with textComments: a selection inside a question card or a host card stays selected after the pointer goes up (copyable); the text still takes comments', async () => {
  const el = await mount({ textComments: true, renderDirectiveBlock: hostCard });
  const card = el.querySelector<HTMLElement>('[data-question-key]')!;
  await select(card, 'Which rounding');
  expect(window.getSelection()!.toString()).toBe('Which rounding');
  expect(toolbarNames()).toEqual([]);

  const action = el.querySelector<HTMLElement>('[data-host-card]')!;
  expect(action.closest('.annotation-exclude')).not.toBeNull();
  await select(action, 'npm publish dist/core.tgz');
  expect(window.getSelection()!.toString()).toBe('npm publish dist/core.tgz');
  expect(toolbarNames()).toEqual([]);
  // Copy takes the live selection, not a toolbar's text.
  const copied = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { setData: (k: string, v: string) => copied.set(k, v) } });
  action.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(copied.size).toBe(0);

  // The library listens again: the next selection in the text opens the comment toolbar.
  await select(el, 'two, four and eight');
  expect(toolbarNames()).toContain('Comment');
});

test.skipIf(!hasDom)('readOnly still wins over textComments', async () => {
  const el = await mount({ textComments: true, readOnly: true });
  await select(el, 'two, four and eight');
  expect(toolbarNames()).toEqual([]);
});
