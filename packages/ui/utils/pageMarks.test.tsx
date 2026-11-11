/**
 * Page marks (`configurePlannotatorUI({ pageMarks: true })`): the attributes a host keys its stylesheet on in place
 * of theme.css's `body:has([data-popout="true"])` (the Plannotator Inbox, build/inbox-page-marks.ts). What regresses
 * if these fail: with the mark gone too early or never set, a popout's page no longer lowers the annotation panel
 * under the dialog; with it left behind, the panel stays lowered after the dialog closed; with two holders, the
 * first to go takes the mark from the other. Off, no host sees an attribute it never asked for.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { holdPageMark, holdPageMarkAbove, resetPageMarks, setPageMarks } from './pageMarks';

const hasDom = typeof document !== 'undefined';
const popout = (hasDom ? await import('../components/PopoutDialog') : {}) as typeof import('../components/PopoutDialog');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  resetPageMarks();
  if (hasDom) document.body.innerHTML = '';
});

describe.skipIf(!hasDom)('page marks', () => {
  test('holds count: the mark stays until the last holder lets go, and a release counts once', () => {
    const el = document.createElement('div');
    const first = holdPageMark(el, 'data-x');
    const second = holdPageMark(el, 'data-x');
    expect(el.hasAttribute('data-x')).toBe(true);
    first();
    first();
    expect(el.hasAttribute('data-x'), 'the second holder still holds it').toBe(true);
    second();
    expect(el.hasAttribute('data-x')).toBe(false);
  });

  test('above an element: every ancestor `scope:has(…)` would match, not the element itself', () => {
    document.body.innerHTML = '<div class="a" id="outer"><div class="a" id="inner"><span class="a" id="leaf"></span></div></div>';
    const release = holdPageMarkAbove(document.getElementById('leaf')!, '.a', 'data-x');
    expect([...document.querySelectorAll('[data-x]')].map((el) => el.id)).toEqual(['outer', 'inner']);
    release();
    expect(document.querySelectorAll('[data-x]').length).toBe(0);
  });

  const mount = (open: boolean) => {
    if (!root) {
      const el = document.createElement('div');
      document.body.appendChild(el);
      root = createRoot(el);
    }
    act(() =>
      root!.render(
        <popout.PopoutDialog open={open} onClose={() => {}} title="Table">
          <p>rows</p>
        </popout.PopoutDialog>,
      ),
    );
  };
  const dialogs = () => document.querySelectorAll('[data-popout="true"]').length;

  test('on: <body data-pn-popout> exactly while a popout\'s dialog is in the page', async () => {
    setPageMarks(true);
    mount(false);
    expect(document.body.hasAttribute('data-pn-popout')).toBe(false);
    mount(true);
    expect(dialogs()).toBe(1);
    expect(document.body.hasAttribute('data-pn-popout')).toBe(true);
    mount(false);
    // Closing, the dialog stays for its exit; the mark stays with it, then goes with it.
    for (let i = 0; i < 40 && dialogs() > 0; i++) {
      expect(document.body.hasAttribute('data-pn-popout')).toBe(true);
      await act(() => new Promise((done) => setTimeout(done, 50)));
    }
    expect(dialogs()).toBe(0);
    expect(document.body.hasAttribute('data-pn-popout')).toBe(false);
  });

  test('off (every other host): a popout marks nothing', async () => {
    mount(true);
    expect(dialogs()).toBe(1);
    expect(document.body.hasAttribute('data-pn-popout')).toBe(false);
  });
});
