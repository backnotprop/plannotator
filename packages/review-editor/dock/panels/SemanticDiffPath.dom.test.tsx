import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SemanticDiffPath } from './SemanticDiffPath';
import { installFakeTextLayout, type FakeTextLayout } from '../../../../tests/helpers/fake-text-layout';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let layout: FakeTextLayout | null = null;

beforeAll(() => {
  if (hasDom) layout = installFakeTextLayout();
});
afterAll(() => layout?.restore());
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
});

describe.skipIf(!hasDom)('the Semantic diff panel file path', () => {
  test('a long path keeps its file name whole; the folders are what give way', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<SemanticDiffPath filePath="android/src/main/kotlin/com/example/billing/receipts/ReceiptPrinter.kt" />));
    await settle();
    const before = layout!.layoutReads();
    await act(async () => layout!.resize((element) => (element.matches('[data-ellipsis-name]') ? 'ReceiptPrinter.kt'.length * 7 + 1 : undefined)));
    await settle();
    const name = host.querySelector<HTMLElement>('[data-ellipsis-shown]')!;
    const dir = host.querySelector<HTMLElement>('[data-semantic-diff-dir]')!;
    expect(name.textContent).toBe('ReceiptPrinter.kt');
    expect(dir.textContent).toBe('android/src/main/kotlin/com/example/billing/receipts/');
    expect(dir.contains(name)).toBe(false);
    expect(layout!.layoutReads() - before).toBe(0);
  });
});
