/**
 * A diagram part's comment card (`configurePlannotatorUI({ commentCard })`), its own drafts (DOM_TESTS=1).
 *
 * Failures to catch:
 * - words left on a part show up on a part of the same name in another document (thread or file);
 * - a Comment the host refused drops the words, so the chevron ("your words are kept") keeps nothing;
 * - a question Ask AI took comes back as a draft on the next open of that part;
 * - the words of a part closed with the chevron are not back on its next open;
 * - a card lifted to the canvas's bottom edge comes in from below that edge, so for its first frames part of it is
 *   outside the diagram and cut off (an inline diagram on a phone, whose box is no taller than the drawing).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resetCommentCardPolicy, setCommentCardEnabled } from '../../utils/commentCardPolicy';

const hasDom = typeof document !== 'undefined';
const { DiagramComposer } = hasDom ? await import('./DiagramComposer') : ({} as typeof import('./DiagramComposer'));
const { CommentDraftScopeContext } = await import('../../utils/commentDraftScope');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  resetCommentCardPolicy();
});

let parts = 0;
interface Props { scope: string; label: string; error?: string | null; onSubmit?: (text: string) => void; onCancel?: () => void; onAskAI?: (q: string) => Promise<boolean>; anchorTop?: number; hostHeight?: number }
async function show(props: Props): Promise<void> {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const tree = (
    <CommentDraftScopeContext.Provider value={props.scope}>
      <DiagramComposer
        draft={{ primary: { element, target: { family: 'flowchart', kind: 'node', id: 'A', label: props.label } }, additional: [], sourceLine: [3, 3] }}
        anchorRect={{ left: 10, top: props.anchorTop ?? 10, width: 20, height: 20 }}
        hostWidth={800}
        hostHeight={props.hostHeight}
        sourceDirty={false}
        submitting={false}
        error={props.error ?? null}
        onSubmit={props.onSubmit ?? (() => {})}
        onCancel={props.onCancel ?? (() => {})}
        onAskAI={props.onAskAI}
      />
    </CommentDraftScopeContext.Provider>
  );
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(tree));
}
async function hide(): Promise<void> {
  await act(async () => root!.render(<></>));
}
const field = () => document.querySelector<HTMLTextAreaElement>('[data-comment-card] textarea')!;
async function type(words: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field(), words);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe.if(hasDom)('DiagramComposer as the comment card', () => {
  test('words closed with the chevron come back on the same part, never on a part of that name in another document', async () => {
    setCommentCardEnabled(true);
    const label = `Start ${++parts}`;
    await show({ scope: 'thread-a/plan.md', label });
    await type('Start sooner.');
    await hide();
    await show({ scope: 'thread-b/other.md', label });
    expect(field().value).toBe('');
    await hide();
    await show({ scope: 'thread-a/plan.md', label });
    expect(field().value).toBe('Start sooner.');
  });

  test('a refused Comment keeps the words; one that went drops them', async () => {
    setCommentCardEnabled(true);
    const label = `Start ${++parts}`;
    await show({ scope: 'doc', label });
    await type('Say why.');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-comment-card-submit]')!.click());
    // The host refuses: an error shows and the box stays; the chevron closes it.
    await show({ scope: 'doc', label, error: 'Could not save.' });
    await hide();
    await show({ scope: 'doc', label });
    expect(field().value).toBe('Say why.');

    await act(async () => document.querySelector<HTMLButtonElement>('[data-comment-card-submit]')!.click());
    await hide();
    await show({ scope: 'doc', label });
    expect(field().value).toBe('');
  });

  test('a question Ask AI took does not come back as a draft', async () => {
    setCommentCardEnabled(true);
    const label = `Start ${++parts}`;
    await show({ scope: 'doc', label, onAskAI: async () => true });
    await type('Why two starts?');
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-diagram-ask-ai]')!.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    await hide();
    await show({ scope: 'doc', label, onAskAI: async () => true });
    expect(field().value).toBe('');
  });

  test('a card lifted to the bottom edge of the canvas comes in from above it; one by its part comes in as usual', async () => {
    setCommentCardEnabled(true);
    // The DOM here lays nothing out: the card is 100 px tall for this test only.
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 100 });
    try {
      const card = () => document.querySelector<HTMLElement>('[data-comment-card]')!;
      // A part low in a 300 px canvas: the card is lifted to end at the canvas's bottom (top 200).
      await show({ scope: 'doc', label: `Low ${++parts}`, anchorTop: 260, hostHeight: 300 });
      expect([card().style.top, card().hasAttribute('data-above')]).toEqual(['200px', true]);
      await hide();
      // A part high in the same canvas: the card sits at its part.
      await show({ scope: 'doc', label: `High ${++parts}`, anchorTop: 40, hostHeight: 300 });
      expect([card().style.top, card().hasAttribute('data-above')]).toEqual(['40px', false]);
    } finally {
      if (own) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', own);
      else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    }
  });
});
