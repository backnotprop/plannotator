/**
 * Ask AI from a diagram comment: the composer offers the markdown
 * composer's "Ask AI" when the host passes its handler, and the question it
 * sends identifies the part.
 *
 * What regresses if these fail:
 * - the diagram composer has no Ask AI (the owner's report), or offers one
 *   that sends before anything is typed;
 * - the question reaches the host without the part's identity (family,
 *   kind, id, label, document line) or the diagram source, so the agent is
 *   asked about "Approve?" with no idea where that is;
 * - a host that passes no handler suddenly shows an Ask AI button;
 * - a question asked in the popout leaves the popout covering the panel the
 *   answer streams into.
 *
 * DOM-gated (DOM_TESTS=1). Same fixture as DiagramBlock.anchor.test.tsx.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installInertDiagramSvgParser } from '../test-setup/diagramSvg';
import type { Annotation, Block } from '../types';
import type { CommentAskAIContext } from './CommentPopover';
import { __setMermaidRuntimeLoaderForTests, setMermaidRuntime } from '../utils/mermaid';
import { parseMarkdownToBlocks } from '../utils/parser';
import { MermaidBlock } from './MermaidBlock';

const hasDom = typeof document !== 'undefined';
const FIXTURES = join(import.meta.dir, '..', 'test-setup', 'fixtures', 'diagrams');
const CAPTURE_ID = 'diagram-fixture';
const SVG = readFileSync(join(FIXTURES, '06-flowchart-review-decision.svg'), 'utf8');
const GEOMETRY = JSON.parse(readFileSync(join(FIXTURES, '06-flowchart-review-decision.geometry.json'), 'utf8')) as {
  elements: Record<string, { bbox: { x: number; y: number; width: number; height: number }; ctm: DOMMatrix }>;
};
const CAPTURED = Object.entries(GEOMETRY.elements).map(([id, entry]) => [id.slice(CAPTURE_ID.length), entry] as const);

const MARKDOWN = [
  '# Plan',
  '',
  'Some prose before the diagram.',
  '',
  '```mermaid',
  'flowchart LR',
  '  U([Reviewer]) --> D{Approve?}',
  '  D -->|Yes| M[(Merge)]',
  '  D -->|No| R[Revise]',
  '```',
  '',
  'Some prose after.',
].join('\n');
/** `D` is declared on line 7 of the document (1-based). */
const D_DOCUMENT_LINE = 7;

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreParser: (() => void) | null = null;
// happy-dom defines the two geometry methods on SVGGraphicsElement, which
// would shadow a stub on SVGElement; install where the engine defines them.
const svgProto = (hasDom ? ((globalThis as { SVGGraphicsElement?: typeof SVGElement }).SVGGraphicsElement ?? SVGElement).prototype : {}) as unknown as Record<string, unknown>;
const elementProto = (hasDom ? Element.prototype : {}) as unknown as Record<string, unknown>;
const saved = { getBBox: svgProto['getBBox'], getScreenCTM: svgProto['getScreenCTM'] };
const noop = (): void => {};

beforeAll(() => {
  if (!hasDom) return;
  restoreParser = installInertDiagramSvgParser();
  setMermaidRuntime(
    { initialize: noop, render: (id: string) => Promise.resolve({ svg: SVG.replaceAll(CAPTURE_ID, id) }) } as unknown as Parameters<typeof setMermaidRuntime>[0],
    'host',
  );
  elementProto['setPointerCapture'] ??= noop;
  elementProto['releasePointerCapture'] ??= noop;
  elementProto['hasPointerCapture'] ??= () => false;
  svgProto['getBBox'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { x: 0, y: 0, width: 452, height: 182 };
    const found = CAPTURED.find(([suffix]) => this.id.endsWith(suffix));
    if (found === undefined) throw new Error(`no captured geometry for ${this.id}`);
    return { ...found[1].bbox };
  };
  svgProto['getScreenCTM'] = function (this: Element) {
    if (this.tagName.toLowerCase() === 'svg') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return CAPTURED.find(([suffix]) => this.id.endsWith(suffix))?.[1].ctm ?? null;
  };
});

afterAll(() => {
  if (!hasDom) return;
  svgProto['getBBox'] = saved.getBBox;
  svgProto['getScreenCTM'] = saved.getScreenCTM;
  __setMermaidRuntimeLoaderForTests(undefined);
  restoreParser?.();
});

afterEach(async () => {
  if (root !== null) {
    const finished = root;
    await act(async () => {
      finished.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
});

function fence(): Block {
  const block = parseMarkdownToBlocks(MARKDOWN).find((b) => b.type === 'code');
  if (block === undefined) throw new Error('no fence');
  return block;
}

async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
}

async function settle(ms = 25): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitFor(check: () => void, tries = 40): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

function pointer(type: string, target: Element): void {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  target.dispatchEvent(
    new Ctor(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 0, ...(Ctor !== MouseEvent ? { pointerId: 1 } : {}) } as MouseEventInit),
  );
}

async function clickNodeD(scope: ParentNode): Promise<void> {
  const node = scope.querySelector('[id$="-flowchart-D-1"]');
  if (node === null) throw new Error('no node D');
  await act(async () => {
    pointer('pointerdown', node);
    pointer('pointerup', node);
  });
}

function typeText(scope: ParentNode, text: string): Promise<void> {
  const textarea = scope.querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea');
  if (textarea === null) throw new Error('no composer');
  return act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function askButton(scope: ParentNode): HTMLButtonElement | null {
  return scope.querySelector<HTMLButtonElement>('[data-diagram-composer] [data-diagram-ask-ai]');
}

type Asked = { question: string; context: CommentAskAIContext };

describe.if(hasDom)('DiagramBlock: Ask AI from a diagram comment', () => {
  test('the button waits for text, and the question carries the part identity and the fence source', async () => {
    const block = fence();
    const asked: Asked[] = [];
    const added: Annotation[] = [];
    await mount(
      <MermaidBlock
        block={block}
        annotations={[]}
        onAddAnnotation={(ann) => added.push(ann)}
        onAskAI={(question, context) => {
          asked.push({ question, context });
          return true;
        }}
        askAISourcePath="/plans/flow.md"
      />,
    );
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await clickNodeD(host!);
    await waitFor(() => expect(askButton(host!)).not.toBeNull());
    expect(askButton(host!)!.disabled).toBe(true);
    await typeText(host!, 'Why does Revise loop back?');
    expect(askButton(host!)!.disabled).toBe(false);
    await act(async () => {
      askButton(host!)!.click();
    });
    await waitFor(() => expect(asked).toHaveLength(1));
    const { question, context } = asked[0]!;
    expect(question).toBe('Why does Revise loop back?');
    expect(context.kind).toBe('selection');
    expect(context.text).toBe('Approve?');
    expect(context.sourcePath).toBe('/plans/flow.md');
    expect(context.detail).toContain(`Diagram node Approve? (D), line ${D_DOCUMENT_LINE}`);
    expect(context.detail).toContain('Mermaid (flowchart)');
    expect(context.detail).toContain('U([Reviewer]) --> D{Approve?}');
    // Asked, not saved: no comment lands, and the composer closes.
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).toBeNull());
    expect(added).toEqual([]);
  });

  test('a question the host refuses keeps the draft open', async () => {
    const block = fence();
    await mount(<MermaidBlock block={block} annotations={[]} onAddAnnotation={noop} onAskAI={() => false} />);
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await clickNodeD(host!);
    await waitFor(() => expect(askButton(host!)).not.toBeNull());
    await typeText(host!, 'still here?');
    await act(async () => {
      askButton(host!)!.click();
    });
    await settle();
    expect(host!.querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea')!.value).toBe('still here?');
  });

  test('while a question is pending, Comment and Enter cannot also save it as a comment', async () => {
    const block = fence();
    const added: Annotation[] = [];
    let release: (accepted: boolean) => void = () => {};
    await mount(
      <MermaidBlock
        block={block}
        annotations={[]}
        onAddAnnotation={(ann) => added.push(ann)}
        onAskAI={() => new Promise<boolean>((resolve) => { release = resolve; })}
      />,
    );
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await clickNodeD(host!);
    await waitFor(() => expect(askButton(host!)).not.toBeNull());
    await typeText(host!, 'pending question');
    await act(async () => {
      askButton(host!)!.click();
    });
    const composer = host!.querySelector('[data-diagram-composer]')!;
    const comment = [...composer.querySelectorAll('button')].find((b) => b.textContent === 'Comment')!;
    expect(comment.disabled).toBe(true);
    await act(async () => {
      composer.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await settle();
    expect(added).toEqual([]);
    // Refused: the draft is editable and savable again.
    await act(async () => {
      release(false);
    });
    await settle();
    expect(comment.disabled).toBe(false);
  });

  test('a host that passes no handler gets the composer it had: no Ask AI', async () => {
    const block = fence();
    await mount(<MermaidBlock block={block} annotations={[]} onAddAnnotation={noop} />);
    await waitFor(() => expect(host!.querySelector('[id$="-flowchart-D-1"]')).not.toBeNull());
    await clickNodeD(host!);
    await waitFor(() => expect(host!.querySelector('[data-diagram-composer]')).not.toBeNull());
    expect(askButton(host!)).toBeNull();
  });

  test('asking from the popout closes it, so the answer is not hidden behind it', async () => {
    const block = fence();
    const asked: Asked[] = [];
    await mount(
      <MermaidBlock
        block={block}
        annotations={[]}
        onAddAnnotation={noop}
        onAskAI={(question, context) => {
          asked.push({ question, context });
        }}
      />,
    );
    await waitFor(() => expect(host!.querySelector('[data-diagram-expand]')).not.toBeNull());
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-diagram-expand]')!.click();
    });
    await waitFor(() => expect(document.querySelector('[data-diagram-popout] [id$="-flowchart-D-1"]')).not.toBeNull());
    const popout = document.querySelector('[data-diagram-popout]')!;
    await clickNodeD(popout);
    await waitFor(() => expect(askButton(popout)).not.toBeNull());
    await typeText(popout, 'from the popout');
    await act(async () => {
      askButton(popout)!.click();
    });
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]!.context.detail).toContain(`(D), line ${D_DOCUMENT_LINE}`);
    await waitFor(() => expect(document.querySelector('[data-diagram-popout]')).toBeNull());
  });
});
