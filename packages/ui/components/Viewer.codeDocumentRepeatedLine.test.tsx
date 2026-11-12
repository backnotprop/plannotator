/**
 * A whole-file code document (a YAML or TOML file is ONE code block) names the line a comment
 * was made on, driven through the REAL Viewer and web-highlighter (DOM-gated, DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Annotation, Block } from '../types';
import type { AnnotationRestoreReport } from '../hooks/useAnnotationHighlighter';
import type { CommentAskAIContext } from './CommentPopover';

const hasDom = typeof document !== 'undefined';
// Viewer and web-highlighter read the DOM at module scope; load lazily so this
// file stays inert in the DOM-less default `bun test` run.
const viewerModule = hasDom ? await import('./Viewer') : null;
const parserModule = hasDom ? await import('../utils/parser') : null;

const QUOTE = 'enabled: true';
const YAML = 'a:\n  enabled: true\nb:\n  enabled: true\n';

interface ViewerHandle {
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

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

interface Mounted {
  container: HTMLElement;
  added: Annotation[];
  asked: CommentAskAIContext[];
  reports: AnnotationRestoreReport[];
  handle: React.RefObject<ViewerHandle | null>;
}

async function mountViewer(blocks: Block[], markdown: string): Promise<Mounted> {
  const Viewer = viewerModule!.Viewer;
  const added: Annotation[] = [];
  const asked: CommentAskAIContext[] = [];
  const reports: AnnotationRestoreReport[] = [];
  const handle = React.createRef<ViewerHandle>();
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        ref={handle as never}
        blocks={blocks}
        markdown={markdown}
        annotations={[]}
        onAddAnnotation={(ann) => added.push(ann)}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="comment"
        inputMethod="drag"
        taterMode={false}
        stickyActions={false}
        disableCodePathValidation
        sourceInfo="/infra/flags.yaml"
        onRestoreReport={(report) => reports.push(report)}
        onAskAI={(_question, context) => {
          asked.push(context);
          return true;
        }}
      />,
    );
  });
  await settle();
  return { container: host!, added, asked, reports, handle };
}

async function selectAt(scope: Element, offset: number, length: number): Promise<void> {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const locate = (target: number, end: boolean): [Text, number] => {
    let seen = 0;
    for (const node of nodes) {
      const len = node.length;
      if (end ? target <= seen + len : target < seen + len) return [node, target - seen];
      seen += len;
    }
    throw new Error(`offset ${target} is past the text`);
  };
  const [startNode, startOffset] = locate(offset, false);
  const [endNode, endOffset] = locate(offset + length, true);
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const article = scope.closest('article') ?? scope;
  await act(async () => {
    article.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function composer(): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!textarea) throw new Error('composer did not open');
  return textarea;
}

async function type(text: string): Promise<HTMLTextAreaElement> {
  const textarea = composer();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set;
  await act(async () => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return textarea;
}

async function askAI(question: string): Promise<void> {
  await type(question);
  const button = [...document.querySelectorAll<HTMLButtonElement>('[data-comment-popover] button')]
    .find((b) => b.textContent?.trim() === 'Ask AI');
  if (!button) throw new Error('Ask AI button missing');
  await act(async () => { button.click(); });
  await settle();
}

async function comment(text: string): Promise<void> {
  await type(text);
  const button = [...document.querySelectorAll<HTMLButtonElement>('[data-comment-popover] button')]
    .find((b) => b.textContent?.trim() === 'Save');
  if (!button) throw new Error('Save button missing');
  await act(async () => { button.click(); });
  await settle();
}

const codeOf = (container: HTMLElement): Element => {
  const code = container.querySelector('[data-block-id="block-0"] code');
  if (!code) throw new Error('code document did not render');
  return code;
};

describe.if(hasDom)('Viewer: a whole-file code document names the commented copy of a repeated line', () => {
  const codeBlocks = () => parserModule!.codeDocumentBlocks(YAML, 'yaml');

  test('a comment on the second `enabled: true` exports line 4, not line 2', async () => {
    const blocks = codeBlocks();
    const { container, added } = await mountViewer(blocks, YAML);
    await selectAt(codeOf(container), YAML.lastIndexOf(QUOTE), QUOTE.length);
    await comment('Turn this one off.');

    expect(added).toHaveLength(1);
    expect(added[0]!.originalText).toBe(QUOTE);
    expect(added[0]!.startOffset).toBe(YAML.lastIndexOf(QUOTE));
    const exported = parserModule!.exportAnnotations(blocks, added);
    expect(exported).toContain(`(line 4) Feedback on: "${QUOTE}"`);
    expect(exported).not.toContain('(line 2)');
  });

  test('Ask AI on the second copy names line 4', async () => {
    const { container, asked } = await mountViewer(codeBlocks(), YAML);
    await selectAt(codeOf(container), YAML.lastIndexOf(QUOTE), QUOTE.length);
    await askAI('Why on?');

    expect(asked).toHaveLength(1);
    expect(asked[0]!.text).toBe(QUOTE);
    expect(asked[0]!.lineStart).toBe(4);
    expect(asked[0]!.lineEnd).toBe(4);
  });

  test('the first copy still names line 2', async () => {
    const blocks = codeBlocks();
    const { container, added, asked } = await mountViewer(blocks, YAML);
    await selectAt(codeOf(container), YAML.indexOf(QUOTE), QUOTE.length);
    await askAI('And this one?');
    expect(asked[0]!.lineStart).toBe(2);
    expect(asked[0]!.lineEnd).toBe(2);
    await selectAt(codeOf(container), YAML.indexOf(QUOTE), QUOTE.length);
    await comment('Keep this one.');
    expect(added).toHaveLength(1);
    expect(parserModule!.exportAnnotations(blocks, added)).toContain(`(line 2) Feedback on: "${QUOTE}"`);
  });
});

// Opened as a code document, the comment must re-attach by its quote and be reported as moved into
// the file's one block at the quote's real place.
const TOML = '# Service config\n[server]\nport = 8080\n';

describe.if(hasDom)('Viewer: a markdown-era draft of a config file re-attaches in the code document', () => {
  test('the comment is painted and moved to block-0 at its own line', async () => {
    const parser = parserModule!;
    const legacyBlocks = parser.parseMarkdownToBlocks(TOML, { frontmatter: false });
    const legacy = await mountViewer(legacyBlocks, TOML);
    const holder = [...legacy.container.querySelectorAll('[data-block-id]')]
      .find((el) => el.textContent?.includes('port = 8080'));
    if (!holder) throw new Error('the markdown render lost the TOML line');
    await selectAt(holder, holder.textContent!.indexOf('port = 8080'), 'port = 8080'.length);
    await comment('Use 8443.');
    expect(legacy.added).toHaveLength(1);
    const draft = legacy.added[0]!;
    expect(draft.blockId).not.toBe('block-0');
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;

    const codeBlocks = parser.codeDocumentBlocks(TOML, 'toml');
    const opened = await mountViewer(codeBlocks, TOML);
    await act(async () => { opened.handle.current!.applySharedAnnotations([draft]); });

    const report = opened.reports.at(-1)!;
    expect(report.unanchored ?? []).toEqual([]);
    const moved = report.moved?.find((m) => m.id === draft.id);
    expect(moved).toMatchObject({ blockId: 'block-0', startOffset: TOML.indexOf('port = 8080') });
    expect(opened.container.querySelector(`[data-block-id="block-0"] [data-bind-id="${draft.id}"], [data-block-id="block-0"] .highlight-mengshou-wrap`)).not.toBeNull();

    const exported = parser.exportAnnotations(codeBlocks, [{ ...draft, blockId: moved!.blockId, startOffset: moved!.startOffset! }]);
    expect(exported).toContain('(line 3) Feedback on: "port = 8080"');
  });
});
