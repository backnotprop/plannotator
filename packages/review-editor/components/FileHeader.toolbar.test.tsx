import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileHeader } from './FileHeader';
import { focusFileHeaderWhenLost } from '../utils/focusFileHeader';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;
const patch = '@@ -1 +1 @@\n-a\n+b\n';
const frames = () => new Promise<void>((resolve) => setTimeout(resolve, 80));

async function mount(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.if(hasDom)('FileHeader as one toolbar', () => {
  test('a long name truncates instead of printing over the counts, with the full path in its title', async () => {
    const path = 'packages/some/deep/folder/a-really-long-file-name-that-would-print-over-the-counts.test.ts';
    const el = await mount(<FileHeader filePath={path} patch={patch} status="renamed" oldPath="old.ts" onToggleViewed={() => {}} />);
    const name = el.querySelector<HTMLElement>('[data-ellipsis-name]')!;
    expect(name.className).toContain('min-w-0');
    expect(name.className).toContain('overflow-hidden');
    expect(name.className).toContain('shrink');
    expect(name.className).not.toContain('flex-none');
    expect(name.closest('[title]')!.getAttribute('title')).toBe(`old.ts → ${path}`);
  });

  test('a renamed file says R in the muted colour at weight 500, like the tree and Go to file', async () => {
    const el = await mount(<FileHeader filePath="b.ts" oldPath="a.ts" status="renamed" patch={patch} />);
    const letter = el.querySelector<HTMLElement>('[data-file-header-status]')!;
    expect(letter.textContent).toBe('R');
    expect(letter.className).toContain('text-muted-foreground');
    expect(letter.className).toContain('font-medium');
    expect(letter.className).not.toContain('#007aff');
  });

  test('one Tab stop per header; arrows, Home and End move between its buttons', async () => {
    const el = await mount(
      <FileHeader filePath="src/a.ts" patch={patch} onToggleViewed={() => {}} onFileComment={() => {}} onStage={() => {}} canStage />,
    );
    const header = el.querySelector<HTMLElement>('[data-file-header]')!;
    expect(header.getAttribute('role')).toBe('toolbar');
    const buttons = [...header.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.length).toBeGreaterThan(2);
    expect(buttons.filter((b) => b.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(buttons.filter((b) => b.getAttribute('tabindex') === '-1')).toHaveLength(buttons.length - 1);

    buttons[0].focus();
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1].getAttribute('tabindex')).toBe('0');
    expect(buttons[0].getAttribute('tabindex')).toBe('-1');
    buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    buttons[buttons.length - 1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  test('after j/k the new file header takes the focus the body would otherwise get', async () => {
    const el = await mount(
      <>
        <FileHeader filePath="src/a.ts" patch={patch} onToggleViewed={() => {}} />
        <FileHeader filePath="src/b.ts" patch={patch} onToggleViewed={() => {}} />
      </>,
    );
    const [first, second] = [...el.querySelectorAll<HTMLElement>('[data-file-header]')];
    (document.activeElement as HTMLElement | null)?.blur();
    focusFileHeaderWhenLost('src/b.ts');
    await frames();
    expect(second.contains(document.activeElement)).toBe(true);

    first.querySelector<HTMLElement>('[tabindex="0"]')!.focus();
    focusFileHeaderWhenLost('src/b.ts');
    await frames();
    expect(second.contains(document.activeElement)).toBe(true);
  });
});
