/**
 * AnnotationPanel per-row Copy for raw-HTML / live-app pinpoints (DOM-gated).
 *
 * Failures to catch: the Copy button appearing on cards that carry no element
 * (markdown surfaces must render byte-identically), missing on one that does,
 * and the copied string drifting from the export's entry for that annotation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationPanel } from './AnnotationPanel';
import { AnnotationType, type Annotation } from '../types';
import { exportAnnotationEntry } from '../utils/parser';

const hasDom = typeof document !== 'undefined';

function row(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    blockId: '',
    startOffset: 0,
    endOffset: 0,
    type: AnnotationType.COMMENT,
    text: `note ${id}`,
    originalText: 'hello',
    createdA: 1,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(ui: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(ui);
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

const baseProps = { isOpen: true, blocks: [], onSelect: () => {}, onDelete: () => {}, selectedId: null };

describe.if(hasDom)('AnnotationPanel element-context Copy', () => {
  test('a markdown annotation renders no Copy button (row byte-identical to before)', async () => {
    const el = await mount(<AnnotationPanel {...baseProps} annotations={[row('a1')]} />);
    expect(el.querySelector('[data-annotation-copy-entry]')).toBeNull();
  });

  test('a pinpoint with element context gets a Copy that puts the export entry on the clipboard', async () => {
    const pinpoint = row('h1', {
      originalText: '[element: Navigation]',
      htmlAnchor: { selector: 'nav#site-nav', tagName: 'nav', text: '' },
      elementContext: { tag: 'nav', id: 'site-nav', path: 'body > nav#site-nav', role: 'navigation', name: 'Primary', outline: '<nav id="site-nav">…</nav>', page: { url: '/dashboard', title: 'Acme' } },
      pageUrl: '/dashboard',
    });
    const written: string[] = [];
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text); } },
    });
    try {
      const el = await mount(<AnnotationPanel {...baseProps} annotations={[pinpoint, row('a2')]} />);
      const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-annotation-copy-entry]'));
      expect(buttons.length).toBe(1);
      expect(buttons[0]!.closest('[data-annotation-id]')!.getAttribute('data-annotation-id')).toBe('h1');
      await act(async () => { buttons[0]!.click(); });
      expect(written.length).toBe(1);
      expect(written[0]).toBe(exportAnnotationEntry(pinpoint, { includeRoute: true }));
      expect(written[0]).toContain('Feedback on the <nav> element — "Primary"');
      expect(written[0]).toContain('- **route** `/dashboard` — "Acme"');
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });
});
