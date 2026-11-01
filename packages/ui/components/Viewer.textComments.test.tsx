/**
 * `Viewer` `textComments` with `answerOnly` (a host that shows a message whose
 * words take comments, the Plannotator Inbox), driven through the REAL Viewer
 * and web-highlighter (DOM-gated, DOM_TESTS=1).
 *
 * Failures to catch: the seam leaks into plain `answerOnly` (a selection
 * there opens a toolbar, a click on a diagram part opens a composer), the
 * toolbar offers Delete or the label picker on a surface that only takes
 * comments, the words of a question card open a toolbar, a diagram part stays
 * read-only under `textComments`, or `readOnly` stops winning. The diagram is
 * the captured Chromium svg of DiagramBlock.askAI.test.tsx's fixture.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation } from '../types';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;
const diagramSvg = hasDom ? await import('../test-setup/diagramSvg') : null;
const mermaid = hasDom ? await import('../utils/mermaid') : null;

const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const CAPTURE_ID = 'diagram-fixture';
const SVG = readFileSync(join(FIXTURES, '06-flowchart-review-decision.svg'), 'utf8');
const GEOMETRY = JSON.parse(readFileSync(join(FIXTURES, '06-flowchart-review-decision.geometry.json'), 'utf8')) as {
  elements: Record<string, { bbox: { x: number; y: number; width: number; height: number }; ctm: DOMMatrix }>;
};
const CAPTURED = Object.entries(GEOMETRY.elements).map(([id, entry]) => [id.slice(CAPTURE_ID.length), entry] as const);
/** `D` is declared on line 3 of the document. */
const DIAGRAM = ['```mermaid', 'flowchart LR', '  U([Reviewer]) --> D{Approve?}', '  D -->|Yes| M[(Merge)]', '  D -->|No| R[Revise]', '```', ''].join('\n');

const svgProto = (hasDom ? ((globalThis as { SVGGraphicsElement?: typeof SVGElement }).SVGGraphicsElement ?? SVGElement).prototype : {}) as unknown as Record<string, unknown>;
const elementProto = (hasDom ? Element.prototype : {}) as unknown as Record<string, unknown>;
const savedProto = { getBBox: svgProto['getBBox'], getScreenCTM: svgProto['getScreenCTM'] };
let restoreParser: (() => void) | null = null;
const noop = (): void => {};

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = diagramSvg!.installInertDiagramSvgParser();
  mermaid!.setMermaidRuntime(
    { initialize: noop, render: (id: string) => Promise.resolve({ svg: SVG.replaceAll(CAPTURE_ID, id) }) } as unknown as Parameters<typeof import('../utils/mermaid').setMermaidRuntime>[0],
    'host',
  );
  elementProto['setPointerCapture'] ??= noop;
  elementProto['releasePointerCapture'] ??= noop;
  elementProto['hasPointerCapture'] ??= () => false;
  svgProto['getBBox'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { x: 0, y: 0, width: 452, height: 182 };
    const found = CAPTURED.find(([suffix]) => this.id.endsWith(suffix));
    return found ? { ...found[1].bbox } : { x: 0, y: 0, width: 0, height: 0 };
  };
  svgProto['getScreenCTM'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return CAPTURED.find(([suffix]) => this.id.endsWith(suffix))?.[1].ctm ?? null;
  };
});

afterAll(() => {
  if (!hasDom) return;
  svgProto['getBBox'] = savedProto.getBBox;
  svgProto['getScreenCTM'] = savedProto.getScreenCTM;
  mermaid!.__setMermaidRuntimeLoaderForTests(undefined);
  restoreParser?.();
});

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

async function mount({ markdown = MARKDOWN, ...props }: { markdown?: string; textComments?: boolean; readOnly?: boolean; onAddAnnotation?: (annotation: Annotation) => void; renderDirectiveBlock?: (block: { directiveKind?: string }) => React.ReactNode | undefined }): Promise<HTMLElement> {
  const Viewer = viewerModule!.Viewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parserModule!.parseMarkdownToBlocks(markdown)}
        markdown={markdown}
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

/** Press and release on node D of the captured diagram; the composer shows if a part takes comments here. */
async function clickDiagramNode(el: HTMLElement): Promise<void> {
  const node = await until(() => el.querySelector('[id$="-flowchart-D-1"]'), 'the rendered diagram');
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  const fire = (kind: string) => node.dispatchEvent(new Ctor(kind, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, ...(Ctor !== MouseEvent ? { pointerId: 1 } : {}) } as MouseEventInit));
  await act(async () => {
    fire('pointerdown');
    fire('pointerup');
  });
  await settle();
}

async function until<T>(read: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const value = read();
    if (value) return value;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

test.skipIf(!hasDom)('answerOnly alone: a click on a diagram part opens no composer', async () => {
  const el = await mount({ markdown: DIAGRAM });
  await clickDiagramNode(el);
  expect(el.querySelector('[data-diagram-composer]')).toBeNull();
});

test.skipIf(!hasDom)('with textComments: a click on a diagram part opens the composer, and Enter hands the host a comment naming the part', async () => {
  const added: Annotation[] = [];
  const el = await mount({ markdown: DIAGRAM, textComments: true, onAddAnnotation: (annotation) => added.push(annotation) });
  await clickDiagramNode(el);
  const area = await until(() => el.querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea'), 'the composer');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Who approves?');
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ type: 'COMMENT', text: 'Who approves?', originalText: 'Approve?', diagramAnchor: { kind: 'node', id: 'D', label: 'Approve?', sourceLine: [3, 3] } });
});

test.skipIf(!hasDom)('readOnly still wins over textComments on a diagram', async () => {
  const el = await mount({ markdown: DIAGRAM, textComments: true, readOnly: true });
  await clickDiagramNode(el);
  expect(el.querySelector('[data-diagram-composer]')).toBeNull();
});

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
