import { act } from 'react';

export function key(target: Element, value: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, composed: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

export function searchInput(host: Element): HTMLInputElement {
  return host.shadowRoot!.querySelector<HTMLInputElement>('[data-file-tree-search-input]')!;
}

export async function typeInSearch(host: Element, text: string): Promise<KeyboardEvent[]> {
  const input = searchInput(host);
  const events: KeyboardEvent[] = [];
  await act(async () => input.focus());
  for (const ch of text) {
    await act(async () => {
      const event = key(input, ch);
      events.push(event);
      if (!event.defaultPrevented) {
        input.value += ch;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: ch }));
      }
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  return events;
}
