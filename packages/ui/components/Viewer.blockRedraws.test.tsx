/**
 * A Viewer drawn again for something its blocks do not show (a selected comment, a new list of comments) draws no
 * block; a question footer that changed draws the question's block only; a checkbox toggled through a new overrides
 * map draws the toggled item. A long plan has hundreds of blocks: before, every Viewer draw drew all of them.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { drawsDuring } from '../../../tests/helpers/react-draws';
import { afterEach, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import type { Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const React = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

const PLAN = [
  '# Release plan',
  '',
  ...Array.from({ length: 12 }, (_, i) => [`Step ${i + 1}: ship the build and check the logs.`, '']).flat(),
  '- [ ] Tag the release',
  '- [ ] Post the notes',
  '',
  ':::question',
  'Which day?',
  '',
  '- [ ] Monday',
  '- [ ] Friday',
  ':::',
].join('\n');

const blocks = hasDom ? parserModule!.parseMarkdownToBlocks(PLAN) : [];
const noop = () => {};
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await React.act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

interface Drawn {
  annotations?: Annotation[];
  selectedAnnotationId?: string | null;
  footer?: () => ReactNode;
  overrides?: Map<string, boolean>;
}

function viewer(drawn: Drawn) {
  const Viewer = viewerModule!.Viewer;
  return (
    <Viewer
      blocks={blocks}
      markdown={PLAN}
      annotations={drawn.annotations ?? []}
      onAddAnnotation={noop}
      onSelectAnnotation={noop}
      selectedAnnotationId={drawn.selectedAnnotationId ?? null}
      mode="selection"
      taterMode={false}
      stickyActions={false}
      disableCodePathValidation
      onToggleCheckbox={noop}
      checkboxOverrides={drawn.overrides}
      renderQuestionFooter={drawn.footer}
    />
  );
}

async function mount(drawn: Drawn) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await React.act(async () => root!.render(viewer(drawn)));
  return host;
}

const redraw = (drawn: Drawn) => drawsDuring(() => React.act(async () => root!.render(viewer(drawn))));

test.skipIf(!hasDom)('a Viewer drawn again for a selected comment or a new comment list draws no block', async () => {
  const footer = () => 'Asked on Monday';
  await mount({ footer });
  expect((await redraw({ footer, selectedAnnotationId: 'ann-1' })).get('BlockRendererBody') ?? 0).toBe(0);
  expect((await redraw({ footer, selectedAnnotationId: 'ann-1', annotations: [] })).get('BlockRendererBody') ?? 0).toBe(0);
});

test.skipIf(!hasDom)('a new question footer draws the question block only, with the new words', async () => {
  const el = await mount({ footer: () => 'Asked on Monday' });
  expect(el.textContent).toContain('Asked on Monday');
  const draws = await redraw({ footer: () => 'Answered on Friday' });
  expect(draws.get('BlockRendererBody')).toBe(1);
  expect(el.textContent).toContain('Answered on Friday');
});

test.skipIf(!hasDom)('a new overrides map draws the toggled item, checked', async () => {
  const el = await mount({ overrides: new Map() });
  const tag = blocks.find((b) => b.content === 'Tag the release')!;
  const item = () => el.querySelector(`[data-block-id="${tag.id}"]`)!;
  expect(item().getAttribute('data-rich-list-checked')).toBe('false');
  await redraw({ overrides: new Map([[tag.id, true]]) });
  expect(item().getAttribute('data-rich-list-checked')).toBe('true');
});
