/** A guide global comment that fails to add keeps its words for the next open (DOM_TESTS=1). */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GuideGlobalCommentPopover } from './GuideGlobalCommentPopover';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

function Harness({ onAdd, jobId }: { onAdd: (text: string) => boolean | void; jobId: string }) {
  const [open, setOpen] = React.useState(true);
  const anchor = React.useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} data-reopen onClick={() => setOpen(true)} />
      {open && anchor.current && (
        <GuideGlobalCommentPopover anchorEl={anchor.current} jobId={jobId} onAdd={onAdd} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

async function mount(onAdd: (text: string) => boolean | void, jobId: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // First render mounts the anchor; the second shows the popover.
  await act(async () => root!.render(<Harness onAdd={onAdd} jobId={jobId} />));
  await act(async () => root!.render(<Harness onAdd={onAdd} jobId={jobId} />));
}

const box = () => document.querySelector<HTMLTextAreaElement>('textarea');

async function type(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(box()!, text);
    box()!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    box()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  });
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('guide global comment popover', () => {
  test('an add that fails shows the words again on the next open', async () => {
    await mount(() => false, 'job-fail');
    await type('keep these words');
    await submit();
    expect(box()).toBeNull();

    await act(async () => document.querySelector<HTMLButtonElement>('[data-reopen]')!.click());
    expect(box()?.value).toBe('keep these words');
  });

  test('an add that works leaves the next open empty', async () => {
    await mount(() => true, 'job-ok');
    await type('saved words');
    await submit();

    await act(async () => document.querySelector<HTMLButtonElement>('[data-reopen]')!.click());
    expect(box()?.value ?? '').toBe('');
  });
});
