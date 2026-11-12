import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationToolbar } from './AnnotationToolbar';
import { AnnotationType } from '../types';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
let anchor: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  anchor?.remove();
  anchor = null;
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('AnnotationToolbar touch targets', () => {
  test('every action carries the icon touch-target markers', async () => {
    anchor = document.createElement('p');
    anchor.textContent = 'annotated paragraph';
    document.body.appendChild(anchor);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <AnnotationToolbar
          element={anchor!}
          positionMode="center-above"
          onAnnotate={() => {}}
          onClose={() => {}}
          onRequestComment={() => {}}
          onQuickLabel={() => {}}
        />,
      );
    });

    const toolbar = document.querySelector<HTMLElement>('.annotation-toolbar');
    if (!toolbar) throw new Error('annotation toolbar did not render');

    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.getAttribute('data-pn-touch-target')).toBe('true');
      expect(button.getAttribute('data-pn-touch-target-icon')).toBe('true');
    }

    expect(toolbar.querySelector('[data-pn-annotation-toolbar-row]')).not.toBeNull();
  });

  test('the actions still fire', async () => {
    anchor = document.createElement('p');
    anchor.textContent = 'annotated paragraph';
    document.body.appendChild(anchor);

    const annotated: AnnotationType[] = [];
    let closes = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <AnnotationToolbar
          element={anchor!}
          positionMode="center-above"
          onAnnotate={(type) => { annotated.push(type); }}
          onClose={() => { closes += 1; }}
        />,
      );
    });

    const find = (label: string) =>
      document.querySelector<HTMLButtonElement>(`.annotation-toolbar button[title="${label}"]`);

    await act(async () => find('Delete')?.click());
    await act(async () => find('Cancel')?.click());
    expect(annotated).toEqual([AnnotationType.DELETION]);
    expect(closes).toBe(1);
  });
});
