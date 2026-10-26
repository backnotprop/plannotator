/** Which window messages the Guides webviews act on. */

/**
 * Only VS Code's webview host drives this page. VS Code posts its messages
 * into the content frame with `contentWindow.postMessage(message,
 * window.origin)` (src/vs/workbench/contrib/webview/browser/pre/index.html,
 * the same in 1.85 and 1.143), so a genuine host message's origin is always
 * this page's own origin; its `source` is not a reliable test (1.143 sets
 * `window.parent = window` inside the content frame, 1.85 deletes it).
 *
 * So a message is acted on only when:
 * - its origin is this page's own origin. That shuts out the agent's answer
 *   page (a sandboxed frame: origin "null") and any page elsewhere in the VS
 *   Code window that has a real origin of its own (a site in the Simple
 *   Browser, another extension's webview) and walks `top.frames` to post here;
 * - and it is not from a frame nested in this page (an extra layer: the
 *   parent chain of the sender reaches this page; `parent` is readable
 *   across origins).
 * When this page's own origin is opaque (a harness page on about:blank or
 * file://), only messages from the page itself or its parent count.
 */
export interface MessageWindow {
  readonly parent: MessageWindow | null | undefined;
  readonly origin?: string;
}

export function fromWebviewHost(event: { source: unknown; origin: string }, self: MessageWindow = window as unknown as MessageWindow): boolean {
  const source = event.source as MessageWindow | null;
  if (source && source !== self && isInside(source, self)) return false;
  const own = self.origin ?? "null";
  if (own === "null") return event.origin === "null" && (source === self || source === self.parent);
  return event.origin === own;
}

/** Whether `w` is a frame nested (at any depth) in `self`. */
function isInside(w: MessageWindow, self: MessageWindow): boolean {
  let cur: MessageWindow | null | undefined = w;
  for (let hops = 0; hops < 32 && cur; hops++) {
    let next: MessageWindow | null | undefined;
    try {
      next = cur.parent;
    } catch {
      return false;
    }
    if (!next || next === cur) return false;
    if (next === self) return true;
    cur = next;
  }
  return false;
}
