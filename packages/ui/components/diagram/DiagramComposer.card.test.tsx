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
interface Props { scope: string; label: string; error?: string | null; onSubmit?: (text: string) => void; onCancel?: () => void; onAskAI?: (q: string) => Promise<boolean> }
async function show(props: Props): Promise<void> {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const tree = (
    <CommentDraftScopeContext.Provider value={props.scope}>
      <DiagramComposer
        draft={{ primary: { element, target: { family: 'flowchart', kind: 'node', id: 'A', label: props.label } }, additional: [], sourceLine: [3, 3] }}
        anchorRect={{ left: 10, top: 10, width: 20, height: 20 }}
        hostWidth={800}
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
});
