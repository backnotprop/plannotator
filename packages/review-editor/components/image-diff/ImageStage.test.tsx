import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StackedStage } from './ImageStage';
import { ImageViewMenu } from './ImageViewMenu';
import { stageLayout, type Size } from './geometry';

const hasDom = typeof document !== 'undefined';

describe.if(hasDom)('the swipe and onion stages stack both images in one box (DOM)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const originalDpr = hasDom ? window.devicePixelRatio : 1;

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

  test('the keyboard moves the divider: arrows by 1%, Shift by 10%, Home and End to the ends; labels name each side', () => {
    const size = { width: 400, height: 200 };
    const layout = stageLayout({ old: size, new: size, available: { width: 800, height: 480 }, zoom: 'fit', dpr: 1 });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    function Harness() {
      const [position, setPosition] = React.useState(0.5);
      return (
        <StackedStage
          mode="swipe"
          before={{ url: 'blob:old', alt: 'Before', size: layout.old! }}
          after={{ url: 'blob:new', alt: 'After', size: layout.new! }}
          layout={layout}
          maxHeight={480}
          position={position}
          onPosition={setPosition}
          opacity={0.5}
          maskColor="blue"
        />
      );
    }
    act(() => root!.render(<Harness />));
    const stage = host.querySelector<HTMLElement>('[data-image-stage]')!;
    expect(stage.getAttribute('role')).toBe('slider');
    expect(stage.tabIndex).toBe(0);
    const press = (key: string, shiftKey = false) =>
      act(() => {
        stage.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
      });
    press('ArrowRight');
    expect(stage.getAttribute('aria-valuenow')).toBe('51');
    press('ArrowLeft', true);
    expect(stage.getAttribute('aria-valuenow')).toBe('41');
    press('End');
    expect(stage.getAttribute('aria-valuenow')).toBe('100');
    press('Home');
    expect(stage.getAttribute('aria-valuenow')).toBe('0');
    expect([...host.querySelectorAll('[data-stage-label]')].map((el) => [el.getAttribute('data-stage-label'), el.textContent])).toEqual([
      ['left', 'Before'],
      ['right', 'After'],
    ]);
  });

  test('the view menu is a button in the tab order', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<ImageViewMenu filePath="a/shot.png" comparable differencesAvailable />));
    const trigger = host.querySelector<HTMLButtonElement>('[data-image-view-menu]')!;
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.getAttribute('aria-label')).toContain('shot.png');
  });
});
