import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommentPopover } from './CommentPopover';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let anchor: HTMLElement | null = null;

async function mount(ui: (el: HTMLElement) => React.ReactElement): Promise<void> {
  anchor = document.createElement('div');
  document.body.appendChild(anchor);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(ui(anchor!)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
const extra = () => document.querySelector<HTMLButtonElement>('[data-comment-extra-action]');
const type = async (words: string) => {
  const field = document.querySelector<HTMLTextAreaElement>('textarea')!;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(field, words);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe.skipIf(!hasDom)('CommentPopover extraAction', () => {
  const base = { contextText: 'A part', isGlobal: false, onSubmit: () => {}, submitLabel: 'Change it', askAILabel: 'Ask', onAskAI: () => {} };

  const primary = () => [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Change it'))!;

  test('absent: the box has no third button, and its footer row does not wrap (as every other host has it)', async () => {
    await mount((el) => <CommentPopover {...base} anchorEl={el} onClose={() => {}} />);
    expect(extra()).toBeNull();
    expect(primary().parentElement!.className.split(' ')).not.toContain('flex-wrap');
  });

  test('present: the row may wrap in a narrow box, and Tab reaches Change it before Show me, as they read on screen', async () => {
    await mount((el) => <CommentPopover {...base} anchorEl={el} onClose={() => {}} extraAction={{ label: 'Show me', onAction: () => {} }} />);
    expect(primary().parentElement!.className.split(' ')).toContain('flex-wrap');
    expect(primary().compareDocumentPosition(extra()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('takes no words: enabled with an empty box, and it closes', async () => {
    const got: string[] = [];
    let closed = 0;
    await mount((el) => <CommentPopover {...base} anchorEl={el} onClose={() => closed++} extraAction={{ label: 'Show me', onAction: (words) => got.push(words) }} />);
    expect(extra()!.disabled).toBe(false);
    await act(async () => extra()!.click());
    expect(got).toEqual(['']);
    expect(closed).toBe(1);
  });

  test('gets the words typed, and Change it stays what it was: it still needs them', async () => {
    const got: string[] = [];
    await mount((el) => <CommentPopover {...base} anchorEl={el} onClose={() => {}} extraAction={{ label: 'Show me', onAction: (words) => got.push(words) }} />);
    expect(primary().disabled).toBe(true);
    await type('  how it adds up ');
    await act(async () => extra()!.click());
    expect(got).toEqual(['how it adds up']);
  });
});
