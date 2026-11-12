import { beforeEach, describe, expect, test } from 'bun:test';
import {
  VIM_SCROLL_MARGIN_MAX,
  VIM_SCROLL_MARGIN_MIN,
  computeVimScrollDelta,
  resolveVimScrollMargin,
  scrollVimTargetIntoView,
} from './vimScroll';

const hasDom = typeof document !== 'undefined';

const viewport = { top: 0, height: 1000 };
const band = { topMargin: 200, bottomMargin: 200 };

describe('computeVimScrollDelta', () => {
  test('leaves a target already inside the safe band untouched', () => {
    expect(computeVimScrollDelta(viewport, { top: 400, bottom: 460 }, band)).toBe(0);
    expect(computeVimScrollDelta(viewport, { top: 200, bottom: 800 }, band)).toBe(0);
  });

  test('reveals a target parked behind the bottom HUD (the j-to-bottom bug)', () => {
    const delta = computeVimScrollDelta(viewport, { top: 960, bottom: 980 }, band);
    expect(delta).toBe(180); // 980 - (1000 - 200)
  });

  test('reveals a target parked behind the top HUD (the k-to-top bug)', () => {
    const delta = computeVimScrollDelta(viewport, { top: 20, bottom: 40 }, band);
    expect(delta).toBe(-180); // 20 - 200
  });

  test('aligns a target taller than the band to its top edge, not its bottom', () => {
    const bottomOnly = 940 - 800; // 140 if we only chased the bottom
    const topRoom = 240 - 200; //   40 before the top slips under the margin
    const delta = computeVimScrollDelta(viewport, { top: 240, bottom: 940 }, band);
    expect(delta).toBe(Math.min(bottomOnly, topRoom));
    expect(delta).toBe(40);
  });

  test('clears the top HUD for a too-tall target whose top is occluded', () => {
    expect(computeVimScrollDelta(viewport, { top: 100, bottom: 900 }, band)).toBe(-100);
  });

  test('leaves a too-tall target straddling the band untouched once its top is clear', () => {
    expect(computeVimScrollDelta(viewport, { top: 200, bottom: 900 }, band)).toBe(0);
  });

  test('accounts for a viewport offset from the page top', () => {
    const offset = { top: 300, height: 400 }; // safe band = page [400, 500]
    const smallBand = { topMargin: 100, bottomMargin: 200 };
    expect(computeVimScrollDelta(offset, { top: 650, bottom: 680 }, smallBand)).toBe(180);
  });
});

describe('resolveVimScrollMargin', () => {
  test('uses the 20% ratio in the ordinary range', () => {
    expect(resolveVimScrollMargin(600)).toBe(120);
  });

  test('clamps short viewports up to the minimum', () => {
    expect(resolveVimScrollMargin(50)).toBe(VIM_SCROLL_MARGIN_MIN);
  });

  test('clamps tall viewports down to the maximum', () => {
    expect(resolveVimScrollMargin(4000)).toBe(VIM_SCROLL_MARGIN_MAX);
  });
});

describe.if(hasDom)('scrollVimTargetIntoView', () => {
  // Clean even when an assertion fires before a test's own teardown, so a
  // failure never leaks stub HUDs into the next test.
  beforeEach(() => {
    document.body.replaceChildren();
  });

  function stubRect(element: HTMLElement, rect: Partial<DOMRect>): void {
    const full = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
    const merged = { ...full, ...rect };
    if (rect.bottom === undefined && rect.height !== undefined) {
      merged.bottom = merged.top + merged.height;
    }
    if (rect.right === undefined && rect.width !== undefined) {
      merged.right = merged.left + merged.width;
    }
    element.getBoundingClientRect = () => merged as DOMRect;
  }

  function buildViewport(clientHeight: number): {
    viewport: HTMLElement;
    target: HTMLElement;
  } {
    const viewportEl = document.createElement('div');
    Object.defineProperty(viewportEl, 'clientHeight', {
      configurable: true,
      value: clientHeight,
    });
    viewportEl.scrollTop = 0;
    const target = document.createElement('p');
    viewportEl.appendChild(target);
    document.body.appendChild(viewportEl);
    return { viewport: viewportEl, target };
  }

  function addHud(
    attribute: string,
    rect: Partial<DOMRect>,
    expanded = false,
  ): void {
    const hud = document.createElement('div');
    hud.setAttribute(attribute, '');
    if (attribute === 'data-vim-key-hud') {
      hud.setAttribute('data-expanded', expanded ? 'true' : 'false');
    }
    stubRect(hud, rect);
    document.body.appendChild(hud);
  }

  test('falls back to the ratio band when no HUD is mounted yet', () => {
    const { viewport: viewportEl, target } = buildViewport(1000);
    stubRect(viewportEl, { top: 0, height: 1000 });
    stubRect(target, { top: 950, bottom: 970, height: 20, width: 100 });

    scrollVimTargetIntoView(target, viewportEl);

    expect(viewportEl.scrollTop).toBe(130);
  });

  test('derives the bottom band from the live key HUD rect', () => {
    const { viewport: viewportEl, target } = buildViewport(1000);
    stubRect(viewportEl, { top: 0, height: 1000 });
    addHud('data-vim-key-hud', { top: 762, bottom: 850, height: 88 });
    stubRect(target, { top: 950, bottom: 970, height: 20, width: 100 });

    scrollVimTargetIntoView(target, viewportEl);

    expect(viewportEl.scrollTop).toBe(216);
  });

  test('shrinks the bottom band to the mode pill instead of over-reserving', () => {
    const { viewport: viewportEl, target } = buildViewport(1000);
    stubRect(viewportEl, { top: 0, height: 1000 });
    addHud('data-vim-mode-badge', { top: 959, bottom: 984, height: 25 });
    // Target at 900..920 was "behind the HUD" under the ratio band but is
    // genuinely clear of the pill, so it must not scroll.
    stubRect(target, { top: 900, bottom: 920, height: 20, width: 100 });

    scrollVimTargetIntoView(target, viewportEl);

    expect(viewportEl.scrollTop).toBe(0);
  });

  test('still reveals a target that is genuinely behind the mode pill', () => {
    const { viewport: viewportEl, target } = buildViewport(1000);
    stubRect(viewportEl, { top: 0, height: 1000 });
    addHud('data-vim-mode-badge', { top: 959, bottom: 984, height: 25 });
    stubRect(target, { top: 960, bottom: 980, height: 20, width: 100 });

    scrollVimTargetIntoView(target, viewportEl);

    expect(viewportEl.scrollTop).toBe(29);
  });

  test('skips the widened band while the key HUD is expanded (modal state)', () => {
    const { viewport: viewportEl, target } = buildViewport(1000);
    stubRect(viewportEl, { top: 0, height: 1000 });
    addHud('data-vim-key-hud', { top: 200, bottom: 760, height: 560 }, true);
    stubRect(target, { top: 950, bottom: 970, height: 20, width: 100 });

    scrollVimTargetIntoView(target, viewportEl);

    expect(viewportEl.scrollTop).toBe(130);
  });

  test('leaves scrollTop untouched when the target is already safe', () => {
    const { viewport: viewportEl, target } = buildViewport(1000);
    stubRect(viewportEl, { top: 0, height: 1000 });
    stubRect(target, { top: 480, bottom: 500, height: 20, width: 100 });

    scrollVimTargetIntoView(target, viewportEl);

    expect(viewportEl.scrollTop).toBe(0);
  });

  test('widens the top band to clear a sticky action bar', () => {
    const { viewport: viewportEl, target } = buildViewport(200);
    stubRect(viewportEl, { top: 0, height: 200 });
    const sticky = document.createElement('div');
    sticky.setAttribute('data-sticky-actions', '');
    viewportEl.appendChild(sticky);
    stubRect(sticky, { top: 0, bottom: 44, height: 44 });
    stubRect(target, { top: 46, bottom: 66, height: 20, width: 100 });
    viewportEl.scrollTop = 20;

    scrollVimTargetIntoView(target, viewportEl);

    expect(viewportEl.scrollTop).toBe(14);
  });

  test('falls back to scrollIntoView when there is no scroll viewport', () => {
    const orphan = document.createElement('p');
    document.body.appendChild(orphan);
    let called = false;
    orphan.scrollIntoView = () => {
      called = true;
    };

    scrollVimTargetIntoView(orphan);

    expect(called).toBe(true);
  });

  test('ignores a zero-size target (unrendered / collapsed)', () => {
    const { viewport: viewportEl, target } = buildViewport(1000);
    stubRect(viewportEl, { top: 0, height: 1000 });
    stubRect(target, { top: 0, bottom: 0, height: 0, width: 0 });
    viewportEl.scrollTop = 42;

    scrollVimTargetIntoView(target, viewportEl);

    expect(viewportEl.scrollTop).toBe(42);
  });
});
