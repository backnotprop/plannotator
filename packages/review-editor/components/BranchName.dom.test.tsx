import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BranchName } from './BranchName';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.if(hasDom)('the phone header draws a branch only when a meaningful piece fits', () => {
  test('under eight characters the branch is not drawn but stays in the accessible text; on desktop the short cut still shows', async () => {
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    const realWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return { width: [...(this.textContent ?? '')].length * 7, height: 16, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {} } as DOMRect;
    };
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 45; } });
    try {
      const branch = 'feature/PLAT-12345/billing-reconciliation/v2-final';
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => root!.render(<BranchName branch={branch} minVisible={8} />));
      expect(host.querySelector('[data-branch-shown]')).toBeNull();
      expect(host.querySelector('.sr-only')!.textContent).toBe(branch);
      await act(async () => root!.render(<BranchName branch={branch} minVisible={0} />));
      expect(host.querySelector('[data-branch-shown]')!.textContent).toBe('…final');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = realRect;
      if (realWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', realWidth);
    }
  });
});
