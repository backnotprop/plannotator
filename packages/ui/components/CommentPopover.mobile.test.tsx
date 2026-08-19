import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { useRef, useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const popoverModule = hasDom ? await import('./CommentPopover') : null;
const CommentPopover = popoverModule?.CommentPopover as typeof import('./CommentPopover')['CommentPopover'];

let host: HTMLElement | null = null;
let root: Root | null = null;
let originalMatchMedia: typeof window.matchMedia | undefined;

function coarseMatchMedia(query: string): MediaQueryList {
  return {
    matches: query.includes('pointer: coarse'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
}

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(ui));
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
}

async function enterText(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(textarea),
    'value',
  )?.set;
  await act(async () => {
    if (setter) setter.call(textarea, value);
    else textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  if (!hasDom) return;
  originalMatchMedia = window.matchMedia;
  window.matchMedia = coarseMatchMedia;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
  }
});

describe('CommentPopover mobile composition', () => {
  test.skipIf(!hasDom)('uses the bounded expanded surface without raising the keyboard on selection', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Comment';
    document.body.appendChild(trigger);
    trigger.focus();
    let closes = 0;

    await mount(
      <CommentPopover
        anchorEl={trigger}
        contextText="selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => { closes += 1; }}
      />,
    );

    const overlay = document.querySelector('.pn-visible-viewport-overlay');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-pn-mobile-editable]');
    expect(overlay).not.toBeNull();
    expect(dialog).not.toBeNull();
    expect(textarea).not.toBeNull();
    expect(document.querySelector('button[title="Collapse"]')).toBeNull();
    expect(document.body.textContent).not.toContain('⌘↵');
    expect(document.body.textContent).not.toContain('Ctrl+Enter');
    expect(document.activeElement).toBe(dialog);

    await act(async () => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(closes).toBe(1);
  });

  test.skipIf(!hasDom)('keeps the token mirror on the same mobile type contract', async () => {
    await mount(
      <CommentPopover
        anchorRect={new DOMRect(100, 100, 60, 20)}
        contextText="selected text"
        isGlobal={false}
        skillReferences
        onSubmit={() => {}}
        onClose={() => {}}
      />,
    );

    expect(document.querySelector('[data-pn-mobile-editable="true"]')).not.toBeNull();
    expect(document.querySelector('[data-pn-mobile-editable-mirror="true"]')).not.toBeNull();
  });

  test.skipIf(!hasDom)('preserves a non-empty draft across backdrop dismissal and restores its trigger', async () => {
    function Harness() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button ref={triggerRef} onClick={() => setOpen(true)}>Open</button>
          {open && (
            <CommentPopover
              anchorEl={triggerRef.current ?? undefined}
              contextText="selected text"
              isGlobal={false}
              draftKey="mobile-draft-test"
              onSubmit={() => {}}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    await mount(<Harness />);
    const trigger = document.querySelector<HTMLButtonElement>('button')!;
    await act(async () => trigger.click());
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-pn-mobile-editable]')!;
    await enterText(textarea, 'Keep this draft');

    const backdrop = document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss comment"]')!;
    await act(async () => backdrop.click());
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(document.querySelector('[data-comment-popover]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    expect(document.querySelector<HTMLTextAreaElement>('[data-pn-mobile-editable]')?.value)
      .toBe('Keep this draft');
  });

  test.skipIf(!hasDom)('keeps focus on a newly tapped outside target', async () => {
    // SAFETY: The test double implements the MediaQueryList surface consumed by the component.
    window.matchMedia = ((query: string): MediaQueryList => ({
      ...coarseMatchMedia(query),
      matches: false,
    })) as typeof window.matchMedia;

    function Harness() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button ref={triggerRef} onClick={() => setOpen(true)}>Open</button>
          <button>Next target</button>
          {open && (
            <CommentPopover
              anchorEl={triggerRef.current ?? undefined}
              anchorRect={new DOMRect(40, 40, 80, 24)}
              contextText="selected text"
              isGlobal={false}
              onSubmit={() => {}}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    await mount(<Harness />);
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
    const trigger = buttons.find((button) => button.textContent === 'Open');
    const nextTarget = buttons.find((button) => button.textContent === 'Next target');
    expect(trigger).not.toBeUndefined();
    expect(nextTarget).not.toBeUndefined();

    await act(async () => trigger?.click());
    await act(async () => {
      nextTarget?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      nextTarget?.focus();
      nextTarget?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));

    expect(document.querySelector('[data-comment-popover]')).toBeNull();
    expect(document.activeElement).toBe(nextTarget);
  });
});
