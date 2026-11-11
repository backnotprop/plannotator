/**
 * One message's body, drawn again only when what it draws from changed (the thread pane's messages are many, and a
 * key typed in "Other" or the reply box changes one card at most).
 *
 * `data` holds everything the body draws from, as plain values: the message (the cache keeps an unchanged message
 * the same object), its answers as shown, each question's footer, its cards' replacements, its comments, and the
 * thread's values it reads. `draw` builds the body from them. The rules that keep it right:
 *  - `draw` reads nothing a render can change besides `data` (a value the body shows goes into `data`);
 *  - the body's event handlers call the pane's newest functions (the pane hands them through a ref), since a body
 *    that did not draw again keeps the handlers of its last draw;
 *  - `data` holds the thread object itself: a kept handler holds its whole pane render (the closure's scope), so every
 *    message draws again when the thread changes and only the newest read's render stays alive, never one per read.
 * Compared field by field: a value is the same object, or an array or a Map holding the same objects.
 */
import { memo, type ReactNode } from 'react';

export type MessageViewData = Readonly<Record<string, unknown>>;

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) if (!b.has(key) || !Object.is(value, b.get(key))) return false;
    return true;
  }
  return false;
}

/** Whether two `data` hold the same values (exported for the pane's own reuse checks). */
export function sameMessageData(a: MessageViewData, b: MessageViewData): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
}

export const MessageView = memo(
  function MessageView({ draw }: { data: MessageViewData; draw: () => ReactNode }) {
    return <>{draw()}</>;
  },
  (before, after) => sameMessageData(before.data, after.data),
);
