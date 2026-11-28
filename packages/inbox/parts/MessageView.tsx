/**
 * One message's body or head, drawn again only when what it draws from changed (the thread pane's messages are many, and a
 * key typed in "Other" or the reply box changes one card at most).
 *
 * `data` holds everything the message draws from, as plain values, and a stable ref to the pane's newest handlers.
 * `draw` is a module-level function of `data` alone: a message that did not draw again keeps its last props, so
 * nothing in them may reach the pane's render (a closure made there would keep each earlier thread alive).
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

type Props<D extends MessageViewData> = { data: D; draw: (data: D) => ReactNode };

export const MessageView = memo(
  function MessageView({ data, draw }: Props<MessageViewData>) {
    return <>{draw(data)}</>;
  },
  (before, after) => before.draw === after.draw && sameMessageData(before.data, after.data),
) as <D extends MessageViewData>(props: Props<D>) => ReactNode;
