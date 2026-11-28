import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { pressKey, typeInto } from '../../ui/test-setup/commentSubmitKeys';

const hasDom = typeof document !== 'undefined';
const { FileCommentCard } = hasDom ? await import('./FileCommentBanner') : ({} as typeof import('./FileCommentBanner'));
const { ReviewSidebar } = hasDom ? await import('./ReviewSidebar') : ({} as typeof import('./ReviewSidebar'));
const { AskAIInput } = hasDom ? await import('./AskAIInput') : ({} as typeof import('./AskAIInput'));

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

const FILE_COMMENT: CodeAnnotation = { id: 'f1', type: 'comment', scope: 'file', filePath: 'src/a.ts', lineStart: 0, lineEnd: 0, side: 'new', text: 'old file remark', createdAt: 1 };
const OUTDATED: CodeAnnotation = { id: 'stale', type: 'comment', scope: 'line', filePath: 'src/a.ts', lineStart: 9, lineEnd: 9, side: 'new', text: 'stale remark', createdAt: 1, outdated: true };

interface Box {
  field: () => HTMLTextAreaElement | null;
  escaped: () => boolean;
}

const BOXES: Array<[string, () => Promise<Box>]> = [
  ['a file comment being edited', async () => {
    await render(<FileCommentCard comment={FILE_COMMENT} isSelected={false} onSelect={() => {}} onEdit={() => {}} onDelete={() => {}} />);
    await act(async () => must<HTMLButtonElement>('[data-annotation-id="f1"] button[title="Edit"]').click());
    await typeInto(must('[data-annotation-id="f1"] textarea'), 'old file remark 日本');
    return { field: () => document.querySelector('[data-annotation-id="f1"] textarea'), escaped: () => !document.querySelector('[data-annotation-id="f1"] textarea') };
  }],
  ['an outdated comment being edited in the sidebar', async () => {
    await render(
      <ReviewSidebar
        isOpen
        onClose={() => {}}
        activeTab="annotations"
        annotations={[OUTDATED]}
        files={[]}
        selectedAnnotationId={null}
        onSelectAnnotation={() => {}}
        onNavigateToAnnotation={() => {}}
        onDeleteAnnotation={() => {}}
        onEditAnnotationText={() => {}}
      />,
    );
    const card = [...document.querySelectorAll<HTMLElement>('div.group')].find((d) => d.textContent?.includes('stale remark'));
    await act(async () => card!.querySelector<HTMLButtonElement>('button[title="Edit"]')!.click());
    const field = 'textarea[aria-label="Edit comment"]';
    await typeInto(must(field), 'stale remark 日本');
    return { field: () => document.querySelector(field), escaped: () => !document.querySelector(field) };
  }],
  ['Ask about this code', async () => {
    let cancels = 0;
    await render(<AskAIInput lineStart={3} lineEnd={3} aiHistory={[]} onSubmit={() => {}} onCancel={() => { cancels++; }} isLoading={false} />);
    await typeInto(must('textarea'), 'なぜ');
    return { field: () => document.querySelector('textarea'), escaped: () => cancels > 0 };
  }],
];

for (const [name, mount] of BOXES) {
  test.skipIf(!hasDom)(`${name}: an IME Escape keeps the box and its words, a plain Escape still acts`, async () => {
    const box = await mount();
    const field = box.field()!;
    const words = field.value;
    await pressKey(field, 'Escape', { isComposing: true });
    await pressKey(field, 'Escape', { keyCode: 229 });
    expect(box.escaped()).toBe(false);
    expect(box.field() === field).toBe(true);
    expect(field.value).toBe(words);
    await pressKey(field, 'Escape');
    expect(box.escaped()).toBe(true);
  });
}
