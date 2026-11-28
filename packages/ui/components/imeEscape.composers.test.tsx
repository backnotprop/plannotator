import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AnnotationType, type Annotation, type CodeAnnotation } from '../types';
import { pressKey, typeInto } from '../test-setup/commentSubmitKeys';

const hasDom = typeof document !== 'undefined';
const { AnnotationPanel } = hasDom ? await import('./AnnotationPanel') : ({} as typeof import('./AnnotationPanel'));
const { DiagramComposer } = hasDom ? await import('./diagram/DiagramComposer') : ({} as typeof import('./diagram/DiagramComposer'));
const { Settings } = hasDom ? await import('./Settings') : ({} as typeof import('./Settings'));
const { QuickLabelsTab } = hasDom ? await import('./settings/QuickLabelsTab') : ({} as typeof import('./settings/QuickLabelsTab'));
const { AttachmentsButton } = hasDom ? await import('./AttachmentsButton') : ({} as typeof import('./AttachmentsButton'));

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(node: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await act(async () => {});
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

const NOTE: Annotation = {
  id: 'a1',
  blockId: 'b1',
  startOffset: 0,
  endOffset: 5,
  type: AnnotationType.COMMENT,
  text: 'ping',
  originalText: 'hello world',
  createdA: 1700000000000,
  author: 'someone',
};
const CODE_NOTE: CodeAnnotation = { id: 'c1', type: 'comment', filePath: 'src/a.ts', lineStart: 3, lineEnd: 3, side: 'new', text: 'old remark', createdAt: 1 };
const PEOPLE = { people: [{ id: 'u1', label: 'Marcus Chen', kind: 'user' as const, detail: null, canOpen: true }] };

interface Box {
  field: () => HTMLTextAreaElement | null;
  escaped: () => boolean;
}

const BOXES: Array<[string, () => Promise<Box>]> = [
  ['the annotation panel: editing a comment', async () => {
    await render(<AnnotationPanel isOpen blocks={[]} annotations={[NOTE]} selectedId={null} onSelect={() => {}} onDelete={() => {}} onEdit={() => {}} mentionSource={PEOPLE} />);
    await act(async () => must<HTMLButtonElement>('button[title="Edit annotation"]').click());
    await typeInto(must('[data-annotation-id] textarea'), 'ping 日本');
    return { field: () => document.querySelector('[data-annotation-id] textarea'), escaped: () => !document.querySelector('[data-annotation-id] textarea') };
  }],
  ['the annotation panel: editing a comment with the @ list open', async () => {
    await render(<AnnotationPanel isOpen blocks={[]} annotations={[NOTE]} selectedId={null} onSelect={() => {}} onDelete={() => {}} onEdit={() => {}} mentionSource={PEOPLE} />);
    await act(async () => must<HTMLButtonElement>('button[title="Edit annotation"]').click());
    await typeInto(must('[data-annotation-id] textarea'), 'ping @mar');
    expect(document.querySelector('[data-mention-picker]')).not.toBeNull();
    return { field: () => document.querySelector('[data-annotation-id] textarea'), escaped: () => !document.querySelector('[data-mention-picker]') };
  }],
  ['the annotation panel: editing a code comment', async () => {
    await render(<AnnotationPanel isOpen blocks={[]} annotations={[]} codeAnnotations={[CODE_NOTE]} selectedId={null} onSelect={() => {}} onDelete={() => {}} onEditCodeAnnotation={() => {}} />);
    await act(async () => must<HTMLButtonElement>('[data-annotation-id="c1"] button[title="Edit annotation"]').click());
    await typeInto(must('[data-annotation-id="c1"] textarea'), 'old remark 日本');
    return { field: () => document.querySelector('[data-annotation-id="c1"] textarea'), escaped: () => !document.querySelector('[data-annotation-id="c1"] textarea') };
  }],
  ['a diagram comment', async () => {
    let cancels = 0;
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    await render(
      <DiagramComposer
        draft={{ primary: { element, target: { family: 'flowchart', kind: 'node', id: 'A', label: 'Start' } }, additional: [], sourceLine: [1, 1] }}
        anchorRect={{ left: 10, top: 10, width: 20, height: 20 }}
        hostWidth={800}
        sourceDirty={false}
        submitting={false}
        error={null}
        onSubmit={() => {}}
        onCancel={() => { cancels++; }}
      />,
    );
    await typeInto(must('textarea'), 'なぜ');
    return { field: () => document.querySelector('textarea'), escaped: () => cancels > 0 };
  }],
];

for (const [name, mount] of BOXES) {
  test.skipIf(!hasDom)(`${name}: an IME Escape keeps the box and its words, a plain Escape still acts`, async () => {
    const box = await mount();
    const field = box.field()!;
    const words = field.value;
    let reachedDocument = 0;
    const spy = () => { reachedDocument++; };
    document.addEventListener('keydown', spy);
    try {
      await pressKey(field, 'Escape', { isComposing: true });
      await pressKey(field, 'Escape', { keyCode: 229 });
      expect(box.escaped()).toBe(false);
      expect(box.field() === field).toBe(true);
      expect(field.value).toBe(words);
      expect(reachedDocument).toBe(0);
      await pressKey(field, 'Escape');
      expect(box.escaped()).toBe(true);
    } finally {
      document.removeEventListener('keydown', spy);
    }
  });
}

interface EnterBox {
  field: () => HTMLInputElement;
  done: () => boolean;
}

const ENTER_BOXES: Array<[string, () => Promise<EnterBox>]> = [
  ['a quick label tip', async () => {
    await render(<QuickLabelsTab />);
    await act(async () => must<HTMLButtonElement>('[data-quick-label-tip-toggle]').click());
    await typeInto(must('[data-quick-label-tip]') as unknown as HTMLTextAreaElement, 'なぜ');
    return { field: () => must('[data-quick-label-tip]'), done: () => !document.querySelector('[data-quick-label-tip]') };
  }],
  ['the identity in Settings', async () => {
    const renamed: string[] = [];
    await render(<Settings taterMode={false} onTaterModeChange={() => {}} mode="plan" externalOpen onIdentityChange={(_old, next) => renamed.push(next)} />);
    const field = must<HTMLInputElement>('input[placeholder="Enter your name..."]');
    await act(async () => field.focus());
    await typeInto(field as unknown as HTMLTextAreaElement, '山田');
    return { field: () => field, done: () => renamed.includes('山田') };
  }],
  ['a directory added in Settings', async () => {
    await render(<Settings taterMode={false} onTaterModeChange={() => {}} mode="plan" externalOpen />);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Files')!.click());
    const browser = must<HTMLButtonElement>('button[role="switch"]');
    if (browser.getAttribute('aria-checked') !== 'true') await act(async () => browser.click());
    const field = must<HTMLInputElement>('input[placeholder="/path/to/directory"]');
    await typeInto(field as unknown as HTMLTextAreaElement, '/work/資料');
    return { field: () => field, done: () => field.value === '' };
  }],
  ['an attachment path', async () => {
    let added = 0;
    await render(<AttachmentsButton images={[]} onAdd={() => { added++; }} onRemove={() => {}} />);
    await act(async () => must<HTMLButtonElement>('button').click());
    const field = must<HTMLInputElement>('input[placeholder="Paste path or URL..."]');
    await typeInto(field as unknown as HTMLTextAreaElement, '/work/画像.png');
    return { field: () => field, done: () => added > 0 };
  }],
];

for (const [name, mount] of ENTER_BOXES) {
  test.skipIf(!hasDom)(`${name}: the Enter that accepts an input method's word does not save, a plain Enter does`, async () => {
    const box = await mount();
    const field = box.field();
    await pressKey(field, 'Enter', { isComposing: true });
    await pressKey(field, 'Enter', { keyCode: 229 });
    expect(box.done()).toBe(false);
    await pressKey(field, 'Enter', { keyCode: 13 });
    expect(box.done()).toBe(true);
  });
}
