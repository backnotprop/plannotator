/**
 * The "Use ⌘ + scroll to zoom" hint (#2127). A plain wheel scrolls an image
 * larger than the stage, which a mouse user read as zoom having stopped
 * working. The failures this guards: the hint missing when the wheel starts
 * scrolling, showing where the wheel did what the reader expected (a fitted
 * image zooms, Ctrl/⌘ + wheel and pinch zoom), showing on a touch-only device,
 * and showing again and again in one viewer.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const stageModule = hasDom ? await import('./ImageZoomStage') : null;
const platform = hasDom ? await import('../utils/platform') : null;

const cleanups: Array<() => void> = [];
let originalMatchMedia: typeof window.matchMedia | undefined;
/** Whether the device has a mouse or trackpad (`(any-pointer: fine)`). */
let finePointer = true;

beforeEach(() => {
  if (!hasDom) return;
  finePointer = true;
  originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('any-pointer: fine') ? finePointer : false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  document.body.replaceChildren();
  if (originalMatchMedia) window.matchMedia = originalMatchMedia;
});

const STAGE = { left: 0, top: 0, width: 1000, height: 600 };

type Gate = import('./ImageZoomStage').WheelHintGate;

/** A stage over a 2000 × 1000 image (Fit 50%), opened at `mode`. */
async function mountStage(mode: 'fit' | 'actual', wheelHint?: Gate | false) {
  const { ImageZoomStage } = stageModule!;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  function Harness() {
    const [m, setM] = React.useState<'fit' | 'actual' | 'zoom'>(mode);
    return <ImageZoomStage src="/x.png" alt="x" label="Image: x" mode={m} onModeChange={setM} stageAttributes={{ 'data-test-stage': '' }} wheelHint={wheelHint} />;
  }
  await act(async () => root.render(<Harness />));
  cleanups.push(() => root.unmount());
  const stage = host.querySelector<HTMLElement>('[data-test-stage]')!;
  stage.getBoundingClientRect = () =>
    ({ ...STAGE, right: STAGE.width, bottom: STAGE.height, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const img = stage.querySelector<HTMLImageElement>('[data-lightbox-image]')!;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 2000 });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1000 });
  await act(async () => { img.dispatchEvent(new Event('load')); });
  return { host, stage, img };
}

/** happy-dom's WheelEvent drops some of its init (the pointer, the modifiers), so they are set on the event. */
function wheelEvent(deltaY: number, init: WheelEventInit = {}) {
  const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'clientX', { value: 500 });
  Object.defineProperty(event, 'clientY', { value: 300 });
  for (const key of ['shiftKey', 'ctrlKey', 'metaKey'] as const) Object.defineProperty(event, key, { value: !!init[key] });
  return event;
}

async function wheel(stage: HTMLElement, deltaY: number, init: WheelEventInit = {}) {
  await act(async () => { stage.dispatchEvent(wheelEvent(deltaY, init)); });
}

/** Past the wheel latch, so the next wheel event starts a new gesture. */
const nextGesture = () => new Promise((r) => setTimeout(r, 300));

const hintOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-wheel-hint]');
const spokenOf = (host: HTMLElement) => host.querySelector('[data-wheel-hint-live]')?.textContent ?? '';
const scaleOf = (img: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(img.style.transform)![1]);

describe.if(hasDom)('ImageZoomStage: the wheel hint (#2127)', () => {
  test('shows when a plain wheel starts scrolling an image, with the platform modifier, said once politely', async () => {
    const { host, stage } = await mountStage('actual');
    expect(hintOf(host)).toBeNull();
    const live = host.querySelector('[data-wheel-hint-live]')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');

    await wheel(stage, 100);
    const hint = hintOf(host)!;
    expect(hint.getAttribute('data-wheel-hint')).toBe('shown');
    expect(hint.getAttribute('aria-hidden')).toBe('true');
    expect(hint.className).toContain('pointer-events-none');
    expect(hint.querySelector('kbd')!.textContent).toBe(platform!.modKey);
    expect(hint.textContent).toContain('scroll to zoom');
    expect(spokenOf(host)).toContain(`hold ${platform!.modKeySpoken} and scroll`);
  });

  test('reproduces the issue: plain wheel zooms in, a pause, then the wheel scrolls and the hint says how to zoom out', async () => {
    const { host, stage, img } = await mountStage('fit');
    for (let i = 0; i < 5; i += 1) await wheel(stage, -100);
    expect(scaleOf(img)).toBeGreaterThan(1);
    expect(hintOf(host)).toBeNull();
    await nextGesture();
    const before = scaleOf(img);
    await wheel(stage, 100);
    expect(scaleOf(img)).toBe(before);
    expect(hintOf(host)!.getAttribute('data-wheel-hint')).toBe('shown');
    // Doing what it says hides it at once, and zooms.
    await wheel(stage, 100, { metaKey: true });
    expect(scaleOf(img)).toBeLessThan(before);
    expect(hintOf(host)!.getAttribute('data-wheel-hint')).toBe('hidden');
  });

  test('never where the wheel already zooms: a fitted image, Ctrl/⌘ + wheel, a trackpad pinch', async () => {
    const fitted = await mountStage('fit');
    await wheel(fitted.stage, -100);
    expect(hintOf(fitted.host)).toBeNull();

    const big = await mountStage('actual');
    await wheel(big.stage, 100, { ctrlKey: true });
    await wheel(big.stage, 100, { metaKey: true });
    // A trackpad pinch arrives as a small Ctrl + wheel.
    await wheel(big.stage, -3.5, { ctrlKey: true });
    // Safari's own pinch: gesture events.
    await act(async () => { big.stage.dispatchEvent(new Event('gesturestart', { cancelable: true })); });
    expect(hintOf(big.host)).toBeNull();
    expect(spokenOf(big.host)).toBe('');
  });

  test('never on a touch-only device', async () => {
    finePointer = false;
    const { host, stage } = await mountStage('actual');
    await wheel(stage, 100);
    expect(hintOf(host)).toBeNull();
  });

  test('stays while the wheel keeps scrolling, fades 2 s after, and does not come back in the same viewer', async () => {
    const gate: Gate = { shown: false };
    const { host, stage } = await mountStage('actual', gate);
    await wheel(stage, 100);
    await new Promise((r) => setTimeout(r, 1200));
    await wheel(stage, 100);
    await new Promise((r) => setTimeout(r, 1200));
    expect(hintOf(host)!.getAttribute('data-wheel-hint')).toBe('shown');
    await act(async () => { await new Promise((r) => setTimeout(r, stageModule!.WHEEL_HINT_HOLD_MS)); });
    expect(hintOf(host)!.getAttribute('data-wheel-hint')).toBe('hidden');
    expect(spokenOf(host)).toBe('');
    // A second scroll in the same stage: nothing.
    await wheel(stage, 100);
    expect(hintOf(host)!.getAttribute('data-wheel-hint')).toBe('hidden');
    // The next image of the same viewer (one gate): nothing either.
    const next = await mountStage('actual', gate);
    await wheel(next.stage, 100);
    expect(hintOf(next.host)).toBeNull();
    // A new viewer (a new gate) shows it again.
    const reopened = await mountStage('actual', { shown: false });
    await wheel(reopened.stage, 100);
    expect(hintOf(reopened.host)!.getAttribute('data-wheel-hint')).toBe('shown');
  }, 10_000);

  test('a press hides it; `wheelHint={false}` turns it off', async () => {
    const { host, stage } = await mountStage('actual');
    await wheel(stage, 100);
    await act(async () => {
      stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 500, clientY: 300, button: 0, pointerType: 'mouse', bubbles: true }));
    });
    expect(hintOf(host)!.getAttribute('data-wheel-hint')).toBe('hidden');

    const off = await mountStage('actual', false);
    await wheel(off.stage, 100);
    expect(hintOf(off.host)).toBeNull();
  });
});
