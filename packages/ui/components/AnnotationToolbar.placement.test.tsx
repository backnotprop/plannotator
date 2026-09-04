import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnnotationToolbar, computeAnnotationToolbarPosition } from './AnnotationToolbar';
import type { VisibleViewportBounds } from '../hooks/useViewportEnvironment';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  if (hasDom) document.body.replaceChildren();
});

const mobileBounds: VisibleViewportBounds = {
  top: 16,
  right: 374,
  bottom: 828,
  left: 16,
  width: 358,
  height: 812,
};

const toolbarSize = { width: 220, height: 40 };

describe('computeAnnotationToolbarPosition', () => {
  test('keeps a centered selection toolbar inside the left viewport edge', () => {
    expect(computeAnnotationToolbarPosition(
      { top: 120, right: 40, bottom: 144, left: 0, width: 40 },
      'center-above',
      toolbarSize,
      mobileBounds,
    )).toEqual({ top: 72, left: 16 });
  });

  test('keeps a block toolbar inside the left viewport edge', () => {
    expect(computeAnnotationToolbarPosition(
      { top: 120, right: 80, bottom: 144, left: 16, width: 64 },
      'top-right',
      toolbarSize,
      mobileBounds,
    )).toEqual({ top: 80, left: 16 });
  });

  test('preserves the existing desktop geometry when it already fits', () => {
    const desktopBounds: VisibleViewportBounds = {
      top: 0,
      right: 1440,
      bottom: 900,
      left: 0,
      width: 1440,
      height: 900,
    };

    expect(computeAnnotationToolbarPosition(
      { top: 320, right: 760, bottom: 344, left: 680, width: 80 },
      'center-above',
      toolbarSize,
      desktopBounds,
    )).toEqual({ top: 272, left: 610 });

    expect(computeAnnotationToolbarPosition(
      { top: 320, right: 760, bottom: 344, left: 680, width: 80 },
      'top-right',
      toolbarSize,
      desktopBounds,
    )).toEqual({ top: 280, left: 540 });
  });

  test('keeps the complete toolbar inside the top and right viewport edges', () => {
    expect(computeAnnotationToolbarPosition(
      { top: 24, right: 390, bottom: 48, left: 350, width: 40 },
      'center-above',
      toolbarSize,
      mobileBounds,
    )).toEqual({ top: 16, left: 154 });
  });
});

describe.if(hasDom)('AnnotationToolbar placement', () => {
  test('applies the measured toolbar width before showing it at the left edge', async () => {
    const anchor = document.createElement('p');
    anchor.getBoundingClientRect = () => ({
      top: 120,
      right: 40,
      bottom: 144,
      left: 0,
      width: 40,
      height: 24,
      x: 0,
      y: 120,
      toJSON: () => ({}),
    });
    const host = document.createElement('div');
    document.body.append(anchor, host);

    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 390 },
      innerHeight: { configurable: true, value: 844 },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.classList.contains('annotation-toolbar')) {
        return {
          top: 0,
          right: 220,
          bottom: 40,
          left: 0,
          width: 220,
          height: 40,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      }
      return originalRect.call(this);
    };

    try {
      root = createRoot(host);
      await act(async () => {
        root?.render(
          <AnnotationToolbar
            element={anchor}
            positionMode="center-above"
            onAnnotate={() => {}}
            onClose={() => {}}
            onRequestComment={() => {}}
            onQuickLabel={() => {}}
          />,
        );
      });

      const toolbar = document.querySelector<HTMLElement>('.annotation-toolbar');
      expect(toolbar?.style.left).toBe('16px');
      expect(toolbar?.style.visibility).toBe('');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      Object.defineProperties(window, {
        innerWidth: { configurable: true, value: originalInnerWidth },
        innerHeight: { configurable: true, value: originalInnerHeight },
      });
    }
  });
});
