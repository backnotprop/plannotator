import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation } from '../types';
import type { CodeFileAnnotationInput, CodeFileViewProps } from './CodeFilePopout';

const hasDom = typeof document !== 'undefined';

let drawn = true;
interface StubProps {
  file: { contents: string };
  lineAnnotations?: { lineNumber: number; metadata: CodeAnnotation }[];
  renderAnnotation?: (annotation: { lineNumber: number; metadata: CodeAnnotation }) => React.ReactNode;
}
const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
mock.module('@pierre/diffs/react', () => ({
  ...realPierreDiffsReact,
  File: function MockFile(props: StubProps) {
    if (!drawn) return null;
    return (
      <div>
        {props.file.contents.split('\n').map((_, i) => (
          <div key={i} data-line={String(i + 1)}>line {i + 1}</div>
        ))}
        {(props.lineAnnotations ?? []).map((a) => (
          <div key={a.metadata.id}>{props.renderAnnotation?.(a)}</div>
        ))}
      </div>
    );
  },
}));

const popoutModule = hasDom ? await import('./CodeFilePopout') : null;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  drawn = true;
  if (hasDom) document.body.replaceChildren();
});

afterAll(() => {
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

const CONTENTS = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'].join('\n');
const SAVED: CodeAnnotation = { id: 'savedOne', type: 'comment' as never, filePath: 'src/a.ts', lineStart: 1, lineEnd: 1, side: 'new', text: 'old words', createdAt: 1 };

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function frames(n = 3) {
  for (let i = 0; i < n; i += 1) await act(async () => { await nextFrame(); });
}

function view(props: Partial<CodeFileViewProps>, added: CodeFileAnnotationInput[], edits: Array<[string, Partial<CodeAnnotation>]>) {
  const CodeFileView = popoutModule!.CodeFileView;
  return (
    <CodeFileView
      filepath="src/a.ts"
      contents={CONTENTS}
      annotations={[SAVED]}
      onAddAnnotation={(a) => added.push(a)}
      onEditAnnotation={(id, updates) => edits.push([id, updates])}
      {...props}
    />
  );
}

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  return (next: React.ReactElement) => act(async () => { root!.render(next); });
}

const composer = () => document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
const submitKey = (el: HTMLTextAreaElement) => act(async () => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
});

describe.if(hasDom)('CodeFileView put-back seams', () => {
  test('reopenComment: once the line is drawn, the composer opens on those lines holding the words; Save adds it then, not before', async () => {
    const added: CodeFileAnnotationInput[] = [];
    const edits: Array<[string, Partial<CodeAnnotation>]> = [];
    drawn = false;
    const request = { lineStart: 2, lineEnd: 3, text: 'b and c are one thought' };
    const rerender = await mount(view({ reopenComment: request }, added, edits));
    await frames();
    expect(composer()).toBeNull();
    drawn = true;
    await rerender(view({ reopenComment: request }, added, edits));
    await frames();
    expect(composer()?.value).toBe('b and c are one thought');
    expect(document.querySelector('[data-comment-popover]')?.textContent).toContain('lines 2-3');
    expect(added).toEqual([]);
    await submitKey(composer()!);
    expect(added.map((a) => [a.lineStart, a.lineEnd, a.text])).toEqual([[2, 3, 'b and c are one thought']]);
    await rerender(view({ reopenComment: request }, added, edits));
    await frames();
    expect(composer()).toBeNull();
  });

  test('reopenEdit: that inline comment opens its edit box holding the words; Save edits it', async () => {
    const added: CodeFileAnnotationInput[] = [];
    const edits: Array<[string, Partial<CodeAnnotation>]> = [];
    await mount(view({ reopenEdit: { id: 'savedOne', text: 'new words not saved' } }, added, edits));
    await frames(1);
    const box = document.querySelector<HTMLTextAreaElement>('[data-code-annotation-id="savedOne"] textarea');
    expect(box?.value).toBe('new words not saved');
    expect(edits).toEqual([]);
    await submitKey(box!);
    expect(edits).toEqual([['savedOne', { text: 'new words not saved' }]]);
  });

  test('onComposerLines: the lines (and their code) as the composer opens, null as it closes', async () => {
    const added: CodeFileAnnotationInput[] = [];
    const edits: Array<[string, Partial<CodeAnnotation>]> = [];
    const told: Array<{ lineStart: number; lineEnd: number; originalCode: string } | null> = [];
    await mount(view({ reopenComment: { lineStart: 2, lineEnd: 3, text: 'kept' }, onComposerLines: (lines) => told.push(lines) }, added, edits));
    await frames();
    expect(composer()?.value).toBe('kept');
    expect(told.at(-1)).toEqual({ lineStart: 2, lineEnd: 3, originalCode: 'const b = 2;\nconst c = 3;' });
    await act(async () => {
      composer()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await frames(1);
    expect(composer()).toBeNull();
    expect(told.at(-1)).toBeNull();
  });

  test('neither prop: no composer and no edit box open by themselves', async () => {
    const added: CodeFileAnnotationInput[] = [];
    const edits: Array<[string, Partial<CodeAnnotation>]> = [];
    await mount(view({}, added, edits));
    await frames();
    expect(composer()).toBeNull();
    expect(document.querySelector('[data-code-annotation-id="savedOne"] textarea')).toBeNull();
  });
});
