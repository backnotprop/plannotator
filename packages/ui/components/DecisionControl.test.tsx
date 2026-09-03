import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DecisionControl, type DecisionHandler } from './DecisionControl';
import { buildDecisionSpec, type DecisionActionId, type DecisionSpecInput } from '../utils/decisionSpec';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;

const REVIEW_FEEDBACK: DecisionSpecInput = {
  app: 'review', gate: true, count: 3, hasFeedback: true, approvalNotesSupported: true,
};
const ANNOTATE_EMPTY: DecisionSpecInput = {
  app: 'annotate', gate: false, count: 0, hasFeedback: false, approvalNotesSupported: false,
};

function makeHandlers(): Record<DecisionActionId, ReturnType<typeof mock>> {
  return {
    'primary': mock((_note?: string) => undefined),
    'note-with-approval': mock((_note?: string) => undefined),
    'request-changes': mock((_note?: string) => undefined),
    'note-with-feedback': mock((_note?: string) => undefined),
    'approve-with-notes': mock((_note?: string) => undefined),
    'discard-and-finish': mock((_note?: string) => undefined),
  };
}

async function mountControl(
  input: DecisionSpecInput,
  handlers: Record<DecisionActionId, DecisionHandler>,
  extraProps: Partial<React.ComponentProps<typeof DecisionControl>> = {},
): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <DecisionControl
        spec={buildDecisionSpec(input)}
        handlers={handlers}
        busy={false}
        isLoading={false}
        {...extraProps}
      />,
    );
  });
}

function popover(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-decision-popover]');
}

async function openMenu(): Promise<void> {
  const caret = document.querySelector<HTMLButtonElement>('[data-decision-caret]');
  if (!caret) throw new Error('caret did not render');
  await act(async () => caret.click());
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
}

async function clickItem(labelPart: string): Promise<void> {
  const item = menuItems().find((el) => el.textContent?.includes(labelPart));
  if (!item) throw new Error(`menu item containing "${labelPart}" not found`);
  await act(async () => item.click());
}

function noteInput(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-decision-note-input]');
  if (!el) throw new Error('note field did not render');
  return el;
}

async function typeNote(value: string): Promise<void> {
  const el = noteInput();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  setter?.call(el, value);
  await act(async () => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressKey(target: EventTarget, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe('DecisionControl', () => {
  // Guards the in-flight branches' zero-state flip coming back: the left
  // segment fires the primary and NEVER opens the popover, in both states.
  test.skipIf(!hasDom)('left segment calls handlers.primary and never opens the popover', async () => {
    for (const input of [ANNOTATE_EMPTY, REVIEW_FEEDBACK]) {
      const handlers = makeHandlers();
      await mountControl(input, handlers);
      const primary = document.querySelector<HTMLButtonElement>('[data-decision-primary]');
      await act(async () => primary!.click());
      expect(handlers.primary).toHaveBeenCalledTimes(1);
      expect(popover()).toBeNull();
      await act(async () => root!.unmount());
      root = null;
      host?.remove();
      host = null;
      document.body.replaceChildren();
    }
  });

  // Guards a revert to a one-line field: Enter stays a newline, Mod+Enter
  // (both modifier spellings) fires the composer action once, trimmed.
  test.skipIf(!hasDom)('Mod+Enter submits the trimmed note; plain Enter does not submit', async () => {
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const handlers = makeHandlers();
      await mountControl(REVIEW_FEEDBACK, handlers);
      await openMenu();
      await clickItem('Send with a note…');
      await typeNote('  ship it  ');

      await pressKey(noteInput(), { key: 'Enter' });
      expect(handlers['note-with-feedback']).not.toHaveBeenCalled();
      expect(popover()?.dataset.decisionPopover).toBe('composer');

      await pressKey(noteInput(), { key: 'Enter', ...modifier });
      expect(handlers['note-with-feedback']).toHaveBeenCalledTimes(1);
      expect(handlers['note-with-feedback']).toHaveBeenCalledWith('ship it');
      expect(popover()).toBeNull();

      await act(async () => root!.unmount());
      root = null;
      host?.remove();
      host = null;
      document.body.replaceChildren();
    }
  });

  // Guards both throwing away a half-typed note and hijacking the host app's
  // own Escape ladder.
  test.skipIf(!hasDom)('Escape ladder: composer keeps the draft, menu consumes, closed propagates', async () => {
    const handlers = makeHandlers();
    await mountControl(REVIEW_FEEDBACK, handlers);

    const documentEscapes: KeyboardEvent[] = [];
    const spy = (event: KeyboardEvent) => {
      if (event.key === 'Escape') documentEscapes.push(event);
    };
    document.addEventListener('keydown', spy);
    try {
      // Rung 1: composer → menu, draft kept.
      await openMenu();
      await clickItem('Send with a note…');
      await typeNote('half a thought');
      await pressKey(noteInput(), { key: 'Escape' });
      expect(popover()?.dataset.decisionPopover).toBe('menu');
      expect(documentEscapes.length).toBe(0);
      await clickItem('Send with a note…');
      expect(noteInput().value).toBe('half a thought');
      await pressKey(noteInput(), { key: 'Escape' });

      // Rung 2: menu → closed, consumed, focus back on the caret.
      const focused = document.activeElement as HTMLElement;
      await pressKey(focused ?? popover()!, { key: 'Escape' });
      expect(popover()).toBeNull();
      expect(documentEscapes.length).toBe(0);
      expect(document.activeElement).toBe(
        document.querySelector('[data-decision-caret]'),
      );

      // Rung 3: nothing open → the event is NOT consumed by the control.
      await pressKey(document.body, { key: 'Escape' });
      expect(documentEscapes.length).toBe(1);
    } finally {
      document.removeEventListener('keydown', spy);
    }
  });

  // The action stays visually enabled and an empty note refocuses the field —
  // never a disabled-gray submit, never an empty submission.
  test.skipIf(!hasDom)('empty note does not submit and refocuses the field', async () => {
    const handlers = makeHandlers();
    await mountControl(REVIEW_FEEDBACK, handlers);
    await openMenu();
    await clickItem('Send with a note…');
    await typeNote('   ');

    const send = document.querySelector<HTMLButtonElement>('[data-decision-composer-send]');
    expect(send?.disabled).toBe(false);
    await act(async () => send!.click());

    expect(handlers['note-with-feedback']).not.toHaveBeenCalled();
    expect(popover()?.dataset.decisionPopover).toBe('composer');
    expect(document.activeElement).toBe(noteInput());
  });

  // Guards a refactor that fires the destructive discard without its one
  // confirm, and the cancel path that must return to the open menu.
  test.skipIf(!hasDom)('discard item raises the confirm; confirm fires, cancel returns to the menu', async () => {
    const handlers = makeHandlers();
    await mountControl(REVIEW_FEEDBACK, handlers);
    await openMenu();
    await clickItem('Approve, discard 3 annotations…');

    const dialog = () =>
      document.querySelector<HTMLElement>('[data-plannotator-confirm-dialog]');
    expect(dialog()).not.toBeNull();
    expect(handlers['discard-and-finish']).not.toHaveBeenCalled();

    // Cancel: back to the open menu, one decision still one click away.
    const cancel = Array.from(dialog()!.querySelectorAll('button')).find(
      (el) => el.textContent === 'Cancel',
    );
    await act(async () => cancel!.click());
    expect(dialog()).toBeNull();
    expect(popover()?.dataset.decisionPopover).toBe('menu');
    expect(handlers['discard-and-finish']).not.toHaveBeenCalled();

    // Confirm: exactly one handler call, after confirmation only.
    await clickItem('Approve, discard 3 annotations…');
    const go = Array.from(dialog()!.querySelectorAll('button')).find(
      // Frozen copy (maintainer-approved): 'Discard & approve'.
      (el) => el.textContent === 'Discard & approve',
    );
    await act(async () => go!.click());
    expect(handlers['discard-and-finish']).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  // Guards the Escape leak: when focus has dropped OUTSIDE the popover (Tab
  // past the last item, click on popover padding), the document-level Escape
  // must dismiss AND consume — the host apps' window-level Escape ladders
  // must never also act on the same keypress. A closed control must not
  // consume anything.
  test.skipIf(!hasDom)('outside-focus Escape dismisses fail-closed; closed control does not consume', async () => {
    const handlers = makeHandlers();
    await mountControl(REVIEW_FEEDBACK, handlers);

    const windowEscapes: KeyboardEvent[] = [];
    const windowSpy = (event: KeyboardEvent) => {
      if (event.key === 'Escape') windowEscapes.push(event);
    };
    window.addEventListener('keydown', windowSpy);
    try {
      // Menu open, focus outside: Escape closes and never reaches window.
      await openMenu();
      (document.activeElement as HTMLElement | null)?.blur?.();
      const consumed = await pressKey(document.body, { key: 'Escape' });
      expect(popover()).toBeNull();
      expect(consumed.defaultPrevented).toBe(true);
      expect(windowEscapes.length).toBe(0);

      // Composer open, focus outside: consume-and-close-ALL (an outside
      // Escape is an outside-dismissal gesture, like an outside click) — and
      // the draft survives the full close.
      await openMenu();
      await clickItem('Send with a note…');
      await typeNote('kept across dismissal');
      (document.activeElement as HTMLElement | null)?.blur?.();
      await pressKey(document.body, { key: 'Escape' });
      expect(popover()).toBeNull();
      expect(windowEscapes.length).toBe(0);
      await openMenu();
      await clickItem('Send with a note…');
      expect(noteInput().value).toBe('kept across dismissal');
      await pressKey(noteInput(), { key: 'Escape' }); // back to menu
      await pressKey(document.activeElement!, { key: 'Escape' }); // close

      // Closed: the control holds no listener, the ladder gets the event.
      const passedThrough = await pressKey(document.body, { key: 'Escape' });
      expect(passedThrough.defaultPrevented).toBe(false);
      expect(windowEscapes.length).toBe(1);
    } finally {
      window.removeEventListener('keydown', windowSpy);
    }
  });

  // Guards the HTML/live-app hang-over-the-page defect: iframe clicks never
  // reach the parent document, so iframe focus must dismiss — but only when
  // the host says the surface is framed.
  test.skipIf(!hasDom)('blur to an iframe dismisses only with dismissOnIframeFocus', async () => {
    for (const framed of [true, false]) {
      const handlers = makeHandlers();
      await mountControl(REVIEW_FEEDBACK, handlers, { dismissOnIframeFocus: framed });
      await openMenu();
      expect(popover()).not.toBeNull();

      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      iframe.focus();
      await act(async () => {
        window.dispatchEvent(new Event('blur'));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      if (framed) expect(popover()).toBeNull();
      else expect(popover()).not.toBeNull();

      iframe.remove();
      await act(async () => root!.unmount());
      root = null;
      host?.remove();
      host = null;
      document.body.replaceChildren();
    }
  });

  // Guards the menu's keyboard contract: arrow keys rove between the
  // role="menuitem" rows and wrap at both ends.
  test.skipIf(!hasDom)('roving focus: Down/Up move between menu items and wrap', async () => {
    const handlers = makeHandlers();
    await mountControl(REVIEW_FEEDBACK, handlers);
    await openMenu();

    const items = menuItems();
    expect(items.length).toBe(3);
    expect(document.activeElement).toBe(items[0]);

    await pressKey(popover()!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    await pressKey(popover()!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[2]);
    await pressKey(popover()!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    await pressKey(popover()!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    await pressKey(popover()!, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    await pressKey(popover()!, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });

  // F6: the spec is live. Without the fallback, deleting the annotations that
  // back an open composer (feedback state -> empty state) leaves the popover
  // rendering an empty shell until Escape.
  test.skipIf(!hasDom)('live spec change that removes the active composer item morphs back to the menu', async () => {
    const handlers = makeHandlers();
    await mountControl(REVIEW_FEEDBACK, handlers);
    await openMenu();
    await clickItem('Send with a note');
    expect(popover()?.dataset.decisionPopover).toBe('composer');
    await typeNote('half-typed');

    // The last annotation is deleted elsewhere: the state flips to empty and
    // `note-with-feedback` leaves the spec while the composer is open.
    await act(async () => {
      root!.render(
        <DecisionControl
          spec={buildDecisionSpec({
            app: 'review', gate: true, count: 0, hasFeedback: false, approvalNotesSupported: true,
          })}
          handlers={handlers}
          busy={false}
          isLoading={false}
        />,
      );
    });

    // Not an empty shell: the popover is back in menu state with the new items.
    expect(popover()?.dataset.decisionPopover).toBe('menu');
    expect(menuItems().length).toBeGreaterThan(0);
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();

    // Same rule for an OPEN CONFIRM (L2): the dialog resolves from the live
    // spec, so when its item leaves the spec it closes back to the menu
    // instead of confirming a stale decision.
    await act(async () => {
      root!.render(
        <DecisionControl
          spec={buildDecisionSpec(REVIEW_FEEDBACK)}
          handlers={handlers}
          busy={false}
          isLoading={false}
        />,
      );
    });
    await clickItem('discard 3');
    const confirmButton = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((el) => el.textContent === 'Discard & approve');
    expect(confirmButton()).toBeDefined();
    await act(async () => {
      root!.render(
        <DecisionControl
          spec={buildDecisionSpec({
            app: 'review', gate: true, count: 0, hasFeedback: false, approvalNotesSupported: true,
          })}
          handlers={handlers}
          busy={false}
          isLoading={false}
        />,
      );
    });
    expect(confirmButton()).toBeUndefined();
    expect(popover()?.dataset.decisionPopover).toBe('menu');
    expect(handlers['discard-and-finish']).not.toHaveBeenCalled();
  });

});
