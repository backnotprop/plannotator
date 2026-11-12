import { describe, expect, test } from 'bun:test';
import { buildSelectionActionElement } from './selectionActionPopover';

const hasDom = typeof document !== 'undefined';

describe.if(hasDom)('buildSelectionActionElement (DOM)', () => {
  test('renders a single Make annotation action', () => {
    const el = buildSelectionActionElement(() => {});
    expect(el.dataset.testid).toBe('edit-selection-action');
    const buttons = el.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    const button = buttons[0];
    expect(button.dataset.testid).toBe('edit-selection-make-annotation');
    expect(button.textContent).toContain('Make annotation');
  });

  test('styles inline through theme tokens (shadow DOM: no app CSS applies)', () => {
    const el = buildSelectionActionElement(() => {});
    const button = el.querySelector('button')!;
    const style = button.getAttribute('style') ?? '';
    expect(style).toContain('var(--card)');
    expect(style).toContain('var(--border)');
    expect(button.className).toBe('');
  });

  test('prevents the default mousedown so the editor selection survives', () => {
    const el = buildSelectionActionElement(() => {});
    const button = el.querySelector('button')!;
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test('click reports the button rect to the callback', () => {
    let received: DOMRect | null = null;
    const el = buildSelectionActionElement((rect) => {
      received = rect;
    });
    document.body.append(el);
    try {
      const button = el.querySelector('button')!;
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(received).not.toBeNull();
      expect(typeof received!.top).toBe('number');
      expect(typeof received!.left).toBe('number');
    } finally {
      el.remove();
    }
  });
});
