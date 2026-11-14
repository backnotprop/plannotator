import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StackedStage } from './ImageStage';
import { stageLayout, type Size } from './geometry';

const hasDom = typeof document !== 'undefined';

describe.if(hasDom)('the swipe and onion stages stack both images in one box (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalDpr = window.devicePixelRatio;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    Object.defineProperty(window, 'devicePixelRatio', { value: originalDpr, configurable: true });
  });

  function render(mode: 'swipe' | 'onion', old: Size, next: Size, width: number, zoom: 'fit' | 'actual', dpr: number, position = 0.5) {
    Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
    const layout = stageLayout({ old, new: next, available: { width, height: 480 }, zoom, dpr });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <StackedStage
          mode={mode}
          before={{ url: 'blob:old', alt: 'Before', size: layout.old! }}
          after={{ url: 'blob:new', alt: 'After', size: layout.new! }}
          layout={layout}
          maxHeight={480}
          position={position}
          onPosition={() => {}}
          opacity={0.5}
          maskColor="blue"
        />,
      ),
    );
    const layers = [...host.querySelectorAll<HTMLImageElement>('[data-image-layer]')];
    return { layout, layers, stage: host.querySelector<HTMLElement>('[data-image-stage]')! };
  }

  for (const width of [390, 768, 1280]) {
    for (const zoom of ['fit', 'actual'] as const) {
      for (const dpr of [1, 2]) {
        test(`same origin and size for both layers at ${width}px, ${zoom}, dpr ${dpr}`, () => {
          const size = { width: 1600, height: 900 };
          const { layout, layers, stage } = render('swipe', size, size, width, zoom, dpr);
          expect(layers.map((l) => l.dataset.imageLayer)).toEqual(['old', 'new']);
          for (const layer of layers) {
            expect(layer.className).toContain('absolute left-0 top-0');
            expect(layer.style.width).toBe(`${layout.stage.width}px`);
            expect(layer.style.height).toBe(`${layout.stage.height}px`);
            expect(layer.style.transform).toBe('');
            expect(layer.style.objectFit).toBe('');
          }
          expect(stage.style.width).toBe(`${layout.stage.width}px`);
          const clip = Number(/inset\(0(?:px)? 0(?:px)? 0(?:px)? ([\d.]+)px\)/.exec(layers[1].style.clipPath)?.[1]);
          const divider = host!.querySelector<HTMLElement>('[data-swipe-divider]')!;
          expect(Number.parseFloat(divider.style.left)).toBe(clip);
          expect(Math.abs(clip * dpr - Math.round(clip * dpr))).toBeLessThan(1e-9);
        });
      }
    }
  }

  test('different sizes: both at the top left corner, each at its own scaled size, the stage the union', () => {
    const { layout, layers, stage } = render('onion', { width: 800, height: 600 }, { width: 640, height: 700 }, 1280, 'actual', 1);
    expect(layers[0].style.width).toBe('800px');
    expect(layers[0].style.height).toBe('600px');
    expect(layers[1].style.width).toBe('640px');
    expect(layers[1].style.height).toBe('700px');
    expect(layers[1].style.opacity).toBe('0.5');
    expect(stage.style.width).toBe(`${layout.stage.width}px`);
    expect(stage.style.height).toBe('700px');
  });
});
