/**
 * AnnotationPanel `unanchoredIds` (DOM-gated).
 *
 * Failures to catch: the chip appearing on a card the host did not flag,
 * missing on one it did, and (the compatibility guard) the panel's DOM
 * changing at all when the prop is absent.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationPanel } from './AnnotationPanel';
import { AnnotationType, type Annotation } from '../types';

const hasDom = typeof document !== 'undefined';

function row(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    blockId: 'b1',
    startOffset: 0,
    endOffset: 5,
    type: AnnotationType.COMMENT,
    text: `note ${id}`,
    originalText: 'hello',
    createdA: Number(id.replace(/\D/g, '')) || 1,
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

const annotations = [row('a1'), row('a2'), row('g3', { type: AnnotationType.GLOBAL_COMMENT, originalText: '' })];
const baseProps = {
  isOpen: true,
  annotations,
  blocks: [],
  onSelect: () => {},
  onDelete: () => {},
  selectedId: null,
};

describe.if(hasDom)('AnnotationPanel unanchoredIds', () => {
  test('absent prop renders exactly today\'s DOM (no chip, byte-identical to an empty set)', async () => {
    const absent = (await mount(<AnnotationPanel {...baseProps} />)).innerHTML;
    await act(async () => { root!.unmount(); });
    root = null;
    host?.remove();
    const empty = (await mount(<AnnotationPanel {...baseProps} unanchoredIds={new Set()} />)).innerHTML;
    expect(absent).toBe(empty);
    expect(absent).not.toContain('data-annotation-unanchored');
  });

  test('only the flagged cards carry the chip, and it follows the set', async () => {
    const el = await mount(<AnnotationPanel {...baseProps} unanchoredIds={new Set(['a2', 'missing'])} />);
    const chips = Array.from(el.querySelectorAll('[data-annotation-unanchored]'));
    expect(chips.length).toBe(1);
    expect(chips[0]!.closest('[data-annotation-id]')!.getAttribute('data-annotation-id')).toBe('a2');

    await act(async () => {
      root!.render(<AnnotationPanel {...baseProps} unanchoredIds={new Set(['a1'])} />);
    });
    const after = Array.from(el.querySelectorAll('[data-annotation-unanchored]'));
    expect(after.length).toBe(1);
    expect(after[0]!.closest('[data-annotation-id]')!.getAttribute('data-annotation-id')).toBe('a1');
  });
});
