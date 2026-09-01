import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewSendControl, REVIEW_NOTE_SEND_LABEL } from './ReviewSendControl';

/**
 * The split Send control's interaction contract (DOM-gated).
 *
 * Each test names the regression it guards; the load-bearing invariant is that
 * "Send Feedback" and "Send with additional feedback" are DIFFERENT buttons —
 * the incumbent left segment never acquires the note, and the note never
 * arrives without an explicit distinct action.
 */

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

interface Handlers {
  onSend: ReturnType<typeof mock>;
  onSubmit: ReturnType<typeof mock>;
}

async function mount(options: { hasFeedback?: boolean } = {}): Promise<Handlers> {
  const onSend = mock(() => {});
  const onSubmit = mock((_text: string) => {});
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ReviewSendControl
        hasFeedback={options.hasFeedback ?? true}
        onSend={onSend}
        note={{ onSubmit }}
      />,
    );
  });
  return { onSend, onSubmit };
}

function primary(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>(
    'button:not([data-review-note-toggle]):not([data-review-note-send])',
  );
  if (!button) throw new Error('primary send segment did not render');
  return button;
}

function caret(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-review-note-toggle]');
  if (!button) throw new Error('caret segment did not render');
  return button;
}

function panel(): HTMLElement | null {
  return host?.querySelector<HTMLElement>('[data-review-note-composer="anchored"]') ?? null;
}

function field(): HTMLTextAreaElement {
  const input = host?.querySelector<HTMLTextAreaElement>('[data-review-note-input]');
  if (!input) throw new Error('note field did not render');
  return input;
}

function noteSend(): HTMLButtonElement {
  const button = host?.querySelector<HTMLButtonElement>('[data-review-note-send]');
  if (!button) throw new Error('note send button did not render');
  return button;
}

async function openPanel() {
  await act(async () => caret().click());
}

async function type(value: string) {
  const input = field();
  // React tracks the node's value, so the prototype setter is what makes the
  // native input event read as a real change.
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(init: KeyboardEventInit) {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

describe('ReviewSendControl', () => {
  test.skipIf(!hasDom)('renders both segments of one pill and starts closed', async () => {
    await mount();
    expect(primary()).toBeTruthy();
    expect(caret().getAttribute('aria-expanded')).toBe('false');
    expect(panel()).toBeNull();
  });

  test.skipIf(!hasDom)('the caret opens the note panel', async () => {
    await mount();
    await openPanel();
    expect(panel()).toBeTruthy();
    expect(caret().getAttribute('aria-expanded')).toBe('true');
  });

  // Guards the most likely "helpful" regression: merging the two actions into
  // one button, at which point a reviewer who typed a note and clicked Send
  // loses it silently.
  test.skipIf(!hasDom)('the left segment sends plainly and never carries the note', async () => {
    const { onSend, onSubmit } = await mount({ hasFeedback: true });
    await openPanel();
    await type('rebase before merging');
    await act(async () => primary().click());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // Guards a revert to a one-line field, which would truncate a multi-line note
  // at the first newline.
  test.skipIf(!hasDom)('Enter is a newline; Mod+Enter submits the note', async () => {
    const { onSubmit } = await mount();
    await openPanel();
    await type('first line');
    await key({ key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();

    await key({ key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('first line');

    // ctrlKey is the same chord off macOS.
    await openPanel();
    await type('ctrl line');
    await key({ key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1][0]).toBe('ctrl line');
  });

  test.skipIf(!hasDom)('the distinct action submits exactly the typed note', async () => {
    const { onSend, onSubmit } = await mount();
    await openPanel();
    await type('split the migration first');
    await act(async () => noteSend().click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe('split the migration first');
    expect(onSend).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  // Guards clearing-on-close (throws away a half-typed note) and the
  // stopPropagation that keeps Escape out of the review app's own ladder.
  test.skipIf(!hasDom)('Escape closes, keeps the text, and does not submit', async () => {
    const { onSubmit } = await mount();
    let escapeReachedApp = false;
    const listener = () => { escapeReachedApp = true; };
    document.addEventListener('keydown', listener);
    try {
      await openPanel();
      await type('half typed');
      await key({ key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', listener);
    }
    expect(panel()).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(escapeReachedApp).toBe(false);

    await openPanel();
    expect(field().value).toBe('half typed');
  });

  // Guards submitting an empty scope:'general' annotation, which would export
  // as a blank bullet under ## General.
  test.skipIf(!hasDom)('the distinct action is disabled for empty and whitespace-only text', async () => {
    const { onSubmit } = await mount();
    await openPanel();
    expect(noteSend().disabled).toBe(true);
    await type('   \n  ');
    expect(noteSend().disabled).toBe(true);
    await key({ key: 'Enter', metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    await type('real');
    expect(noteSend().disabled).toBe(false);
  });

  // Guards a regression that raises the "No Annotations" dialog from a button
  // whose whole purpose at zero annotations is the note.
  test.skipIf(!hasDom)('with nothing to send the primary opens the panel instead of sending', async () => {
    const { onSend } = await mount({ hasFeedback: false });
    await act(async () => primary().click());
    expect(onSend).not.toHaveBeenCalled();
    expect(panel()).toBeTruthy();
  });

  test.skipIf(!hasDom)('a pointerdown outside the control closes the panel', async () => {
    await mount();
    await openPanel();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    await act(async () => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    outside.remove();
    expect(panel()).toBeNull();
  });

  // Deliberately frozen, maintainer-approved label — the note action must stay
  // distinguishable from the incumbent "Send Feedback". Not a prose snapshot.
  test.skipIf(!hasDom)('the panel action reads "Send with additional feedback"', async () => {
    await mount();
    await openPanel();
    expect(noteSend().textContent).toBe('Send with additional feedback');
    expect(REVIEW_NOTE_SEND_LABEL).toBe('Send with additional feedback');
  });
});
