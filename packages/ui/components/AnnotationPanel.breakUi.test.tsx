/**
 * AnnotationPanel cards under worst-case data (Workspaces' break-ui pass).
 *
 * What regresses if this fails: an unbroken token (a long URL, a stack trace,
 * a German compound) in a comment runs past the card instead of wrapping; a
 * comment from an earlier year reads as this year ("Oct 20"); a long author
 * name pushes the time out of the card; or a right-to-left name splits the
 * time around itself ("6 · <name> m").
 *
 * happy-dom does no layout, so the wrap and truncation rules are asserted as
 * the classes that carry them; the headless screenshots in the PR show them.
 *
 * DOM-gated (DOM_TESTS=1).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationPanel } from './AnnotationPanel';
import { AnnotationType, type Annotation, type CodeAnnotation } from '../types';
import { parseMarkdownToBlocks } from '../utils/parser';
import { resetIdentityProvider, setIdentityProvider } from '../utils/identity';

const hasDom = typeof document !== 'undefined';

const URL_TOKEN =
  'https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a?tab=comments&filter=unresolved&assignee=christopher.alexander.montgomery';
const COMPOUND = 'Benachrichtigungseinstellungsänderungsprotokollierungsverordnungskonformitätsprüfung';
const LONG_NAME = 'Christopher Alexander Montgomery III';
const RTL_NAME = 'نور الهدى عبد الرحمن';

const blocks = parseMarkdownToBlocks('# Plan\n\nSome text here.\n');

function comment(id: string, over: Partial<Annotation> = {}): Annotation {
  return {
    id,
    blockId: blocks[0].id,
    startOffset: 0,
    endOffset: 4,
    type: AnnotationType.COMMENT,
    text: 'A comment',
    originalText: 'Plan',
    createdA: Date.now() - 6 * 60 * 1000,
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(annotations: Annotation[], codeAnnotations: CodeAnnotation[] = []): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AnnotationPanel
        isOpen
        annotations={annotations}
        codeAnnotations={codeAnnotations}
        blocks={blocks}
        onSelect={() => {}}
        onDelete={() => {}}
        selectedId={null}
      />,
    );
  });
  return host;
}

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
});

const card = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-annotation-id="${id}"]`)!;
const bodyOf = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll('p')).find((p) => p.textContent === text)!;

describe('AnnotationPanel worst-case cards', () => {
  test.skipIf(!hasDom)('unbroken tokens wrap inside the card: root, reply, global and code bodies', async () => {
    const root1 = comment('root', { text: URL_TOKEN });
    const reply = comment('reply', { text: COMPOUND, inReplyTo: 'root' });
    const global = comment('global', { type: AnnotationType.GLOBAL_COMMENT, text: COMPOUND + ' global', originalText: '' });
    const code: CodeAnnotation = {
      id: 'code1', type: 'comment', filePath: 'src/a.ts', lineStart: 1, lineEnd: 2, side: 'new', scope: 'line',
      text: URL_TOKEN + '#code', createdAt: Date.now(),
    };
    const el = await mount([root1, reply, global], [code]);
    for (const text of [URL_TOKEN, COMPOUND, COMPOUND + ' global', URL_TOKEN + '#code']) {
      const p = bodyOf(el, text);
      expect(p).toBeDefined();
      expect(p.className).toContain('[overflow-wrap:anywhere]');
    }
  });

  test.skipIf(!hasDom)('a code card on a Windows path names the file, not the whole path', async () => {
    const code: CodeAnnotation = {
      id: 'win', type: 'comment', filePath: 'C:\\repo\\src\\a.ts', lineStart: 1, lineEnd: 2, side: 'new', scope: 'line',
      text: 'check this', createdAt: Date.now(),
    };
    const el = await mount([], [code]);
    const text = card(el, 'win').textContent ?? '';
    expect(text).toContain('a.ts · lines 1-2');
    expect(text).not.toContain('C:\\repo');
  });

  test.skipIf(!hasDom)('a comment from an earlier year names its year; this year does not', async () => {
    const old = new Date(2023, 9, 20, 12).getTime();
    // 30 days back: older than the relative "Nd" window, and this year
    // except in January.
    const recent = Date.now() - 30 * 86_400_000;
    const el = await mount([comment('old', { createdA: old }), comment('new', { createdA: recent })]);
    const oldTime = card(el, 'old').querySelector('[data-annotation-time]')!.textContent!;
    expect(oldTime).toContain('2023');
    expect(oldTime).toBe(new Date(old).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
    const newTime = card(el, 'new').querySelector('[data-annotation-time]')!.textContent!;
    if (new Date(recent).getFullYear() === new Date().getFullYear()) {
      expect(newTime).toBe(new Date(recent).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    }
  });

  test.skipIf(!hasDom)('a long author name truncates with its full name as the title; the time stays outside it', async () => {
    const el = await mount([comment('long', { author: LONG_NAME })]);
    const c = card(el, 'long');
    const author = c.querySelector<HTMLElement>('[data-annotation-author]')!;
    const time = c.querySelector<HTMLElement>('[data-annotation-time]')!;
    expect(author.className).toContain('truncate');
    expect(author.getAttribute('title')).toBe(LONG_NAME);
    expect(time.className).toContain('shrink-0');
    expect(author.contains(time)).toBe(false);
    expect(time.textContent).toBe('6m');
    // The line still reads as it did.
    expect(c.querySelector('[data-annotation-byline]')!.textContent).toBe(`${LONG_NAME} · 6m`);
  });

  test.skipIf(!hasDom)('"(me)" sits outside the truncating name, so the ellipsis cannot hide it', async () => {
    setIdentityProvider({ getIdentity: () => LONG_NAME, isCurrentUser: (a) => a === LONG_NAME });
    try {
      const el = await mount([comment('mine', { author: LONG_NAME })]);
      const c = card(el, 'mine');
      const author = c.querySelector<HTMLElement>('[data-annotation-author]')!;
      const me = c.querySelector<HTMLElement>('[data-annotation-me]')!;
      expect(me.textContent).toBe(' (me)');
      expect(me.className).toContain('shrink-0');
      expect(author.contains(me)).toBe(false);
      expect(c.querySelector('[data-annotation-byline]')!.textContent).toBe(`${LONG_NAME} (me) · 6m`);
    } finally {
      resetIdentityProvider();
    }
  });

  test.skipIf(!hasDom)('a right-to-left name is isolated, so the time is not split around it', async () => {
    const el = await mount([comment('rtl', { author: RTL_NAME })]);
    const c = card(el, 'rtl');
    const bdi = c.querySelector('[data-annotation-author] bdi')!;
    expect(bdi.textContent).toBe(RTL_NAME);
    expect(bdi.contains(c.querySelector('[data-annotation-time]'))).toBe(false);
  });
});
