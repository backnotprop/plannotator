import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseMarkdownToBlocks } from '../utils/parser';

const hasDom = typeof document !== 'undefined';

const viewerMod = hasDom ? await import('./Viewer') : null;
const Viewer = viewerMod?.Viewer as typeof import('./Viewer')['Viewer'];

const GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
const DOC = [
  ':::question',
  'Which drawer?',
  'Stakes: ships Thursday.',
  'Reversible: no — the old code is deleted',
  '',
  `- [ ] A — ![Drawer A](${GIF})`,
  `- [ ] B — ![Drawer B](${GIF})`,
  '',
  'Recommended: B',
  '',
  'Why: it keeps the total next to Pay.',
  ':::',
].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(props: { questionContractLines?: boolean; questionPictureChoices?: boolean }) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parseMarkdownToBlocks(DOC)}
        markdown={DOC}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="comment"
        taterMode={false}
        disableCodePathValidation
        {...props}
      />,
    );
  });
  return host.querySelector<HTMLElement>('fieldset.question-block')!;
}

describe('Viewer question props', () => {
  test.skipIf(!hasDom)('default (plan review, annotate): the contract lines are plain context; picture choices are tiles', async () => {
    const card = await render({});
    expect(card.querySelector('[data-question-part="stakes"]')).toBeNull();
    expect(card.querySelector('[data-question-part="why"]')).toBeNull();
    expect(card.querySelector('[data-question-irreversible]')).toBeNull();
    expect(card.textContent).toContain('Stakes: ships Thursday.');
    expect(card.textContent).toContain('Why: it keeps the total next to Pay.');
    expect(card.textContent).toContain('Reversible: no — the old code is deleted');
    expect(card.querySelectorAll('[data-question-tile]').length).toBe(2);
  });

  test.skipIf(!hasDom)('questionContractLines (the Inbox): the card draws Stakes, Why and the tag', async () => {
    const card = await render({ questionContractLines: true });
    expect(card.querySelector('[data-question-part="stakes"]')!.textContent).toBe('ships Thursday.');
    expect(card.querySelector('[data-question-part="why"]')!.textContent).toBe('Why B: it keeps the total next to Pay.');
    expect(card.querySelector('[data-question-irreversible]')).not.toBeNull();
    expect(card.textContent).not.toContain('Stakes:');
  });

  test.skipIf(!hasDom)('questionPictureChoices={false}: text rows with plain labels', async () => {
    const card = await render({ questionPictureChoices: false });
    expect(card.querySelectorAll('[data-question-tile]').length).toBe(0);
    const labels = Array.from(card.querySelectorAll('label[data-question-option] [data-question-part="choice"] > span:first-child')).map((s) => s.textContent);
    expect(labels).toEqual(['A', 'B']);
  });
});
