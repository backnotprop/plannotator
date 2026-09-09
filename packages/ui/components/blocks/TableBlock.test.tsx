import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Block } from '../../types';

const hasDom = typeof document !== 'undefined';
const tableBlockModule = hasDom ? await import('./TableBlock') : null;
const TableBlock = tableBlockModule?.TableBlock as typeof import('./TableBlock')['TableBlock'];

describe.if(hasDom)('TableBlock', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  test('clears the viewer action float while retaining horizontal overflow', async () => {
    const block: Block = {
      id: 'table-1',
      type: 'table',
      content: '| Name | Value |\n| --- | --- |\n| Alpha | 1 |',
      order: 0,
      startLine: 1,
    };

    await act(async () => {
      root.render(<TableBlock block={block} />);
    });

    const container = host.querySelector<HTMLElement>('[data-block-id="table-1"]');
    expect(container).not.toBeNull();
    expect(container?.classList.contains('clear-right')).toBe(true);
    expect(container?.classList.contains('overflow-x-auto')).toBe(true);
  });
});
