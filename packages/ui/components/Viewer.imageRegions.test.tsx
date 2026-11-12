import { afterEach, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;
const panelModule = hasDom ? await import('./AnnotationPanel') : null;

const MARKDOWN = [
  '# Status colors for v2.0',
  '',
  'Paused jobs keep their slot in the queue.',
  '',
  'The sheet below is exported from Figma at 2×.',
  '![Job status colors](figures/status-colors.png)',
  '',
  'Rollout next.',
  '',
].join('\n');

const STAGE = { left: 0, top: 0, width: 1000, height: 600 };

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

type Report = { attempted: string[]; unanchored: string[] };

async function mountHost(markdown: string, initial: Annotation[] = [], reports: Report[] = []) {
  const Viewer = viewerModule!.Viewer;
  const AnnotationPanel = panelModule!.AnnotationPanel;
  const state: { annotations: Annotation[]; selected: string | null } = { annotations: initial, selected: null };
  function Host() {
    const [annotations, setAnnotations] = useState<Annotation[]>(initial);
    const [selected, setSelected] = useState<string | null>(null);
    state.annotations = annotations;
    state.selected = selected;
    const blocks = parserModule!.parseMarkdownToBlocks(markdown);
    return (
      <>
        <Viewer
          blocks={blocks}
          markdown={markdown}
          annotations={annotations}
          onAddAnnotation={(a) => {
            setAnnotations((list) => [...list, a]);
            setSelected(a.id);
          }}
          onDeleteAnnotation={(id) => setAnnotations((list) => list.filter((a) => a.id !== id))}
          onEditAnnotation={(id, updates) => setAnnotations((list) => list.map((a) => (a.id === id ? { ...a, ...updates } : a)))}
          onSelectAnnotation={setSelected}
          selectedAnnotationId={selected}
          onRestoreReport={(r) => reports.push({ attempted: [...r.attempted], unanchored: [...r.unanchored] })}
          mode="selection"
          taterMode={false}
          stickyActions={false}
          disableCodePathValidation
          imageLightboxStepping
          imageRegionComments
        />
        <div data-test-panel="">
          <AnnotationPanel
            isOpen
            presentation="embedded"
            blocks={blocks}
            annotations={annotations}
            selectedId={selected}
            onSelect={setSelected}
            onDelete={() => {}}
          />
        </div>
      </>
    );
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Host />);
  });
  await settle();
  return state;
}

async function loadImage() {
  const stage = document.querySelector<HTMLElement>('[data-lightbox-stage]')!;
  stage.getBoundingClientRect = () =>
    ({ ...STAGE, right: STAGE.width, bottom: STAGE.height, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const img = stage.querySelector<HTMLImageElement>('[data-lightbox-image]')!;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 2000 });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1000 });
  await act(async () => { img.dispatchEvent(new Event('load')); });
  return { stage, img };
}

async function pointer(target: HTMLElement, type: string, x: number, y: number, id = 1, pointerType = 'mouse') {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, button: 0, pointerType, bubbles: true, cancelable: true }));
  });
}

function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

async function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function openViewer() {
  const image = document.querySelector<HTMLImageElement>('article img.cursor-zoom-in')!;
  expect(image.getAttribute('data-image-src')).toBe('figures/status-colors.png');
  await act(async () => image.click());
  await settle();
  return loadImage();
}

test.skipIf(!hasDom)('draw a box in Region mode, write the comment, save: one COMMENT with the region in the image\'s own pixels', async () => {
  const state = await mountHost(MARKDOWN);
  const { stage } = await openViewer();
  const viewer = document.querySelector<HTMLElement>('[data-image-lightbox]')!;
  const move = viewer.querySelector<HTMLButtonElement>('[data-region-tool="move"]')!;
  const region = viewer.querySelector<HTMLButtonElement>('[data-region-tool="region"]')!;
  expect(move.getAttribute('role')).toBe('radio');
  expect(move.getAttribute('aria-checked')).toBe('true');
  expect(viewer.querySelector('[data-region-count]')!.textContent).toBe('0');

  await act(async () => region.click());
  expect(region.getAttribute('aria-checked')).toBe('true');
  expect(stage.getAttribute('data-region-tool-active')).toBe('region');

  await pointer(stage, 'pointerdown', 100, 150);
  await pointer(stage, 'pointermove', 200, 200);
  expect(viewer.querySelector('[data-region-draft]')).not.toBeNull();
  expect(viewer.querySelector('[data-region-size]')!.textContent).toBe('200 × 100');
  await pointer(stage, 'pointermove', 300, 250);
  await pointer(stage, 'pointerup', 300, 250);
  await settle();
  expect(viewer.querySelector('[data-region-pending]')).not.toBeNull();

  const composer = document.querySelector<HTMLElement>('[data-comment-popover]')!;
  expect(composer.textContent).toContain('Region 1 · 400 × 200 px');
  const textarea = composer.querySelector('textarea')!;
  // Keys typed in the composer never reach the page behind the viewer.
  const seen: string[] = [];
  const probe = (e: KeyboardEvent) => seen.push(e.key);
  window.addEventListener('keydown', probe);
  await typeInto(textarea, 'the paused box should be grey');
  textarea.focus();
  await act(async () => { press('a'); });
  window.removeEventListener('keydown', probe);
  expect(seen).toEqual([]);
  await act(async () => { press('Enter', { metaKey: true }); });
  await settle();

  expect(state.annotations).toHaveLength(1);
  const saved = state.annotations[0]!;
  expect(saved.type).toBe(AnnotationType.COMMENT);
  expect(saved.text).toBe('the paused box should be grey');
  expect(saved.originalText).toBe('figures/status-colors.png');
  expect(saved.imageRegion).toEqual({
    v: 1,
    src: 'figures/status-colors.png',
    sourceLine: 6,
    box: { x: 200, y: 200, w: 400, h: 200 },
    naturalWidth: 2000,
    naturalHeight: 1000,
  });
  const imageBlock = parserModule!.parseMarkdownToBlocks(MARKDOWN).find((b) => b.content.includes('status-colors.png'))!;
  expect(saved.blockId).toBe(imageBlock.id);
  const card = document.querySelector<HTMLElement>(`[data-test-panel] [data-annotation-id="${saved.id}"]`)!;
  expect(card.querySelector('[data-annotation-region]')).not.toBeNull();
  expect(card.textContent).toContain('status-colors.png');
  expect(card.textContent).toContain('400 × 200 px · line 6');
  expect(card.textContent).not.toContain('"figures/status-colors.png"');

  expect(viewer.querySelector(`[data-region-box="${saved.id}"]`)).not.toBeNull();
  expect(region.getAttribute('aria-checked')).toBe('true');
  expect(viewer.querySelector('[data-region-count]')!.textContent).toBe('1');
  expect(document.querySelector('[data-comment-popover]')).toBeNull();

  stage.focus();
  await act(async () => { press('Escape'); });
  expect(move.getAttribute('aria-checked')).toBe('true');
  expect(document.querySelector('[data-image-lightbox]')).not.toBeNull();

  const out = parserModule!.exportAnnotations(parserModule!.parseMarkdownToBlocks(MARKDOWN), state.annotations);
  expect(out).toContain('Feedback on a region of the image figures/status-colors.png\nImage: figures/status-colors.png (line 6)\nRegion: x=200 y=200 w=400 h=200 (of 2000×1000)\n> the paused box should be grey');
});

test.skipIf(!hasDom)('the count opens the drawer; a card zooms to its box; delete removes the comment', async () => {
  const saved: Annotation = {
    id: 'r1',
    blockId: parserModule!.parseMarkdownToBlocks(MARKDOWN).find((b) => b.content.includes('status-colors.png'))!.id,
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: 'retry goes back to Failed',
    originalText: 'figures/status-colors.png',
    createdA: 1,
    imageRegion: { v: 1, src: 'figures/status-colors.png', sourceLine: 6, box: { x: 1500, y: 700, w: 100, h: 50 }, naturalWidth: 2000, naturalHeight: 1000 },
  };
  const state = await mountHost(MARKDOWN, [saved]);
  const { img } = await openViewer();
  const viewer = document.querySelector<HTMLElement>('[data-image-lightbox]')!;
  const count = viewer.querySelector<HTMLButtonElement>('[data-region-count]')!;
  expect(count.textContent).toBe('1');
  expect(count.getAttribute('aria-expanded')).toBe('false');
  await act(async () => count.click());
  const drawer = viewer.querySelector<HTMLElement>('[data-region-drawer]')!;
  expect(count.getAttribute('aria-controls')).toBe(drawer.id);
  const card = drawer.querySelector<HTMLElement>('[data-annotation-id="r1"]')!;
  expect(card.textContent).toContain('retry goes back to Failed');
  expect(card.textContent).toContain('100 × 50 px · line 6');

  await act(async () => card.click());
  const m = /scale\(([\d.]+)\)/.exec(img.style.transform)!;
  expect(Number(m[1])).toBeCloseTo(Math.min(500 / 100, 300 / 50), 5);
  expect(viewer.querySelector('[data-region-box="r1"]')!.hasAttribute('data-region-selected')).toBe(true);

  card.focus();
  await act(async () => { press('Escape'); });
  expect(viewer.querySelector('[data-region-drawer]')).toBeNull();
  expect(document.activeElement).toBe(count);

  await act(async () => count.click());
  const remove = viewer.querySelector<HTMLButtonElement>('[data-region-drawer] [data-annotation-id="r1"] button[aria-label="Delete annotation"], [data-region-drawer] [data-annotation-id="r1"] button[title="Delete annotation"]')
    ?? [...viewer.querySelectorAll<HTMLButtonElement>('[data-region-drawer] [data-annotation-id="r1"] button')].at(-1)!;
  await act(async () => remove.click());
  expect(state.annotations).toHaveLength(0);
  expect(viewer.querySelector('[data-region-box="r1"]')).toBeNull();
});

test.skipIf(!hasDom)('after a reload the saved box is drawn again; it is anchored while its image is there, unanchored once it is gone; nothing is painted in the text', async () => {
  const saved: Annotation = {
    id: 'r1',
    blockId: 'whatever',
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: 'grey',
    originalText: 'figures/status-colors.png',
    createdA: 1,
    imageRegion: { v: 1, src: 'figures/status-colors.png', sourceLine: 6, box: { x: 200, y: 200, w: 400, h: 200 }, naturalWidth: 2000, naturalHeight: 1000 },
  };
  const reports: Report[] = [];
  await mountHost(MARKDOWN, [saved], reports);
  expect(document.querySelector('mark[data-bind-id="r1"]')).toBeNull();
  const last = reports.filter((r) => r.attempted.includes('r1')).at(-1)!;
  expect(last.unanchored).not.toContain('r1');
  await openViewer();
  const box = document.querySelector<HTMLElement>('[data-region-box="r1"]')!;
  expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['100px', '150px', '200px', '100px']);

  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  document.body.replaceChildren();
  const goneReports: Report[] = [];
  await mountHost(MARKDOWN.replace('![Job status colors](figures/status-colors.png)', 'The image was removed.'), [saved], goneReports);
  expect(goneReports.filter((r) => r.attempted.includes('r1')).at(-1)!.unanchored).toContain('r1');
});

test.skipIf(!hasDom)('selecting a region card in the document\'s panel opens the viewer on its image with its card selected', async () => {
  const saved: Annotation = {
    id: 'r9',
    blockId: 'b',
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: 'legend still lists Blocked',
    originalText: 'figures/status-colors.png',
    createdA: 1,
    imageRegion: { v: 1, src: 'figures/status-colors.png', sourceLine: 6, box: { x: 10, y: 10, w: 50, h: 50 }, naturalWidth: 2000, naturalHeight: 1000 },
  };
  await mountHost(MARKDOWN, [saved]);
  expect(document.querySelector('[data-image-lightbox]')).toBeNull();
  await act(async () => document.querySelector<HTMLElement>('[data-test-panel] [data-annotation-id="r9"]')!.click());
  await settle();
  const viewer = document.querySelector<HTMLElement>('[data-image-lightbox]')!;
  expect(viewer).not.toBeNull();
  expect(viewer.querySelector('[data-region-drawer] [data-annotation-id="r9"]')).not.toBeNull();
});

async function drawAndSave(stage: HTMLElement, from: [number, number], to: [number, number], text: string) {
  await act(async () => document.querySelector<HTMLButtonElement>('[data-region-tool="region"]')!.click());
  await pointer(stage, 'pointerdown', ...from);
  await pointer(stage, 'pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  await pointer(stage, 'pointermove', ...to);
  await pointer(stage, 'pointerup', ...to);
  await settle();
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
  await typeInto(textarea, text);
  textarea.focus();
  await act(async () => { press('Enter', { metaKey: true }); });
  await settle();
}

test.skipIf(!hasDom)('a comment made in the viewer opens it again from its card after the viewer is closed', async () => {
  // Regression: the viewer's own add was remembered for good, so the card of
  // a comment made in this session never reopened the viewer (until a reload).
  const state = await mountHost(MARKDOWN);
  const { stage } = await openViewer();
  await drawAndSave(stage, [100, 150], [300, 250], 'grey, not orange');
  const id = state.annotations[0]!.id;
  expect(document.querySelector('[data-region-drawer]')).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-lightbox-close]')!.click());
  await settle();
  expect(document.querySelector('[data-image-lightbox]')).toBeNull();
  expect(state.selected).toBeNull();

  await act(async () => document.querySelector<HTMLElement>(`[data-test-panel] [data-annotation-id="${id}"]`)!.click());
  await settle();
  const viewer = document.querySelector<HTMLElement>('[data-image-lightbox]')!;
  expect(viewer).not.toBeNull();
  const { img } = await loadImage();
  await settle();
  const scale = Number(/scale\(([\d.]+)\)/.exec(img.style.transform)![1]);
  expect(scale).toBeCloseTo(Math.min(500 / 400, 300 / 200), 5);
  expect(viewer.querySelector(`[data-region-box="${id}"]`)!.hasAttribute('data-region-selected')).toBe(true);
  expect(viewer.querySelector(`[data-region-drawer] [data-annotation-id="${id}"]`)).not.toBeNull();
});

test.skipIf(!hasDom)('a box waiting for its comment keeps the viewer on its image: stepping away is refused, the words stay', async () => {
  const TWO = `${MARKDOWN}\n![Second](figures/second.png)\n`;
  await mountHost(TWO);
  const { stage } = await openViewer();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-region-tool="region"]')!.click());
  await pointer(stage, 'pointerdown', 100, 150);
  await pointer(stage, 'pointermove', 300, 250);
  await pointer(stage, 'pointerup', 300, 250);
  await settle();
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!;
  await typeInto(textarea, 'half written');
  const viewer = document.querySelector<HTMLElement>('[data-image-lightbox]')!;
  expect(viewer.querySelector('[data-lightbox-count]')!.textContent).toBe('1 of 2');
  await act(async () => viewer.querySelector<HTMLButtonElement>('[data-lightbox-next]')!.click());
  expect(viewer.querySelector('[data-lightbox-count]')!.textContent).toBe('1 of 2');
  expect(viewer.querySelector('[data-lightbox-end-note]')!.textContent).toBe('Save or close the comment first');
  expect(document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea')!.value).toBe('half written');
});

test.skipIf(!hasDom)('a comment is anchored only while the document references its image as a whole', async () => {
  const saved: Annotation = {
    id: 'r2',
    blockId: 'b',
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: 'x',
    originalText: 'a.png',
    createdA: 1,
    imageRegion: { v: 1, src: 'a.png', sourceLine: 3, box: { x: 0, y: 0, w: 1, h: 1 }, naturalWidth: 10, naturalHeight: 10 },
  };
  const reports: Report[] = [];
  await mountHost('# Doc\n\n![one](data.png)\n\n![two](a.png.bak)\n', [saved], reports);
  expect(reports.filter((r) => r.attempted.includes('r2')).at(-1)!.unanchored).toContain('r2');
});

test.skipIf(!hasDom)('a single image: in Move a tap beside the image closes the viewer (its click swallowed, #2067); in Region it does not', async () => {
  await mountHost(MARKDOWN);
  const { stage } = await openViewer();
  const tapBeside = async () => {
    await pointer(stage, 'pointerdown', 500, 10);
    await pointer(stage, 'pointerup', 500, 10);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { stage.dispatchEvent(click); });
    await settle();
    return click;
  };

  await act(async () => document.querySelector<HTMLButtonElement>('[data-region-tool="region"]')!.click());
  await tapBeside();
  expect(document.querySelector('[data-image-lightbox]')).not.toBeNull();

  await act(async () => document.querySelector<HTMLButtonElement>('[data-region-tool="move"]')!.click());
  const click = await tapBeside();
  expect(document.querySelector('[data-image-lightbox]')).toBeNull();
  expect(click.defaultPrevented).toBe(true);
});
