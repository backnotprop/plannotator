import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BranchName } from './BranchName';
import { installFakeTextLayout, type FakeTextLayout } from '../../../tests/helpers/fake-text-layout';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

let layout: FakeTextLayout | null = null;
beforeAll(() => {
  if (hasDom) layout = installFakeTextLayout();
});
afterAll(() => layout?.restore());

const resize = (width: number) => act(async () => layout!.resize(() => width));

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.if(hasDom)('the phone header draws a branch only when a meaningful piece fits', () => {
  test('under eight characters the branch is not drawn but stays in the accessible text; on desktop the short cut still shows', async () => {
    const branch = 'feature/PLAT-12345/billing-reconciliation/v2-final';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<BranchName branch={branch} minVisible={8} />));
    await resize(45);
    expect(host.querySelector('[data-branch-shown]')).toBeNull();
    expect(host.querySelector('.sr-only')!.textContent).toBe(branch);
    await act(async () => root!.render(<BranchName branch={branch} minVisible={0} />));
    await resize(45);
    expect(host.querySelector('[data-branch-shown]')!.textContent).toBe('…final');
  });
});
