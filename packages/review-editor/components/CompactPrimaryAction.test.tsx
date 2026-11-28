import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CompactPrimaryAction, compactPrimaryAction } from './CompactPrimaryAction';
import type { CompactReviewAction } from './ReviewHeaderMenu';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.if(hasDom)('the phone header keeps the primary review action in view', () => {
  test('the decision, not Exit, sits in the header and runs the same action as the menu row', async () => {
    const approve = mock(() => {});
    const actions: CompactReviewAction[] = [
      { id: 'exit', label: 'Exit review', onSelect: () => {} },
      { id: 'approve', label: 'Approve', onSelect: approve },
      { id: 'feedback', label: 'Send feedback', onSelect: () => {} },
    ];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<CompactPrimaryAction action={compactPrimaryAction(actions)} />));
    const button = host.querySelector<HTMLButtonElement>('[data-compact-primary]')!;
    expect(button.textContent).toBe('Approve');
    expect(button.hasAttribute('data-pn-touch-target')).toBe(true);
    await act(async () => button.click());
    expect(approve).toHaveBeenCalledTimes(1);
  });

  test('a session with no agent shows Copy feedback; nothing to decide shows nothing', async () => {
    expect(compactPrimaryAction([{ id: 'copy', label: 'Copy feedback', onSelect: () => {} }])?.id).toBe('copy');
    expect(compactPrimaryAction([{ id: 'exit', label: 'Exit review', onSelect: () => {} }])).toBeUndefined();
  });
});
