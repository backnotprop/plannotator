/**
 * A saved comment's card under its line (DOM-gated). The Inbox's file panes opt
 * into a plain card (`commentCard="plain"`): the words as plain text, no left
 * bar (a bar reads as a quote, and the comment is not one), and a sentence-case
 * "Comment" label. Every other host (code review, the plan popout, Workspaces)
 * passes nothing and keeps the card it had.
 *
 * What regresses: the bar or the uppercase label coming back in the Inbox, or
 * the opt-in leaking into the default card.
 *
 * Pierre's `File` is replaced by a stub that draws each line annotation through
 * the view's `renderAnnotation`, the way Pierre does under the line.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation } from '../types';

const hasDom = typeof document !== 'undefined';

interface StubFileProps {
  lineAnnotations?: { lineNumber: number; metadata?: CodeAnnotation }[];
  renderAnnotation?: (annotation: { lineNumber: number; metadata?: CodeAnnotation }) => React.ReactNode;
}

const realPierreDiffsReact = { ...(await import('@pierre/diffs/react')) };
mock.module('@pierre/diffs/react', () => ({
  ...realPierreDiffsReact,
  File: function StubFile({ lineAnnotations = [], renderAnnotation }: StubFileProps) {
    return <div>{lineAnnotations.map((a, i) => <div key={i}>{renderAnnotation?.(a)}</div>)}</div>;
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
});

afterAll(() => {
  mock.module('@pierre/diffs/react', () => realPierreDiffsReact);
});

const COMMENT: CodeAnnotation = {
  id: 'c1',
  type: 'comment',
  filePath: 'src/retry/worker.ts',
  lineStart: 42,
  lineEnd: 42,
  side: 'new',
  text: 'Keep the flag off for invoices over $10k.',
  createdAt: 0,
};

async function card(commentCard?: 'plain'): Promise<HTMLElement> {
  const CodeFileView = popoutModule!.CodeFileView;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<CodeFileView filepath="src/retry/worker.ts" contents={'const a = 1;\n'.repeat(50)} annotations={[COMMENT]} commentCard={commentCard} />);
  });
  const el = host.querySelector<HTMLElement>('[data-code-annotation-id="c1"]');
  if (!el) throw new Error('comment card missing');
  return el;
}

const words = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('div')].find((d) => d.textContent === COMMENT.text)!;
const labelRow = (el: HTMLElement) => el.firstElementChild as HTMLElement;

describe.if(hasDom)('CodeFileView saved comment card', () => {
  test('a host that passes nothing keeps the card as it was: left bar and uppercase label', async () => {
    const el = await card();
    expect(words(el).className).toContain('border-l-2');
    expect(labelRow(el).className).toContain('uppercase');
    expect(labelRow(el).className).toContain('tracking-wide');
  });

  test('the plain card (the Inbox): no left bar, a sentence-case label', async () => {
    const el = await card('plain');
    expect(words(el).className).not.toContain('border-l');
    expect(words(el).className).not.toContain('pl-2');
    expect(labelRow(el).className).not.toContain('uppercase');
    expect(labelRow(el).className).not.toContain('tracking');
    expect(labelRow(el).textContent).toContain('Comment');
    expect(labelRow(el).textContent).toContain('line 42');
  });
});
