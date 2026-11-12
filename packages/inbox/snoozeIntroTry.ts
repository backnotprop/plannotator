/**
 * The Snooze announcement's "Try it" (approval "inbox-snooze-announce"): it opens the REAL Snooze menu, as the
 * person's own click would, and stops there. It never picks a time, so it never snoozes anything by itself.
 *
 *  - A thread open, off a phone: that thread's header ⋯ menu, swapped to its times.
 *  - A thread open, on a phone: that thread's ⋯ sheet, swapped to its times.
 *  - No thread open, off a phone: the right-click menu of the row just left, swapped to its times.
 *  - No thread open, on a phone: the thread just left opens again, then its ⋯ sheet, swapped to its times.
 *
 * It presses the same buttons a person does (Base UI opens a menu on the pointer's press), so a change to those menus
 * reaches it. True when a Snooze menu is on screen.
 */

export interface SnoozeTryTarget {
  /** Where the window is drawn (`.pn-inbox`, or the document). */
  root: ParentNode;
  phone: boolean;
  /** The thread open now, or null. */
  openThread: string | null;
  /** The thread the person just left (the moment), or null. */
  left: string | null;
  /** Open a thread (a phone with none open). */
  openLeft: (threadId: string) => void;
}

const WAIT_MS = 2500;

/** Wait for `find` to answer, a frame at a time (the menus draw a render or two later). */
async function until<T>(find: () => T | null | undefined, ms = WAIT_MS): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > end) return null;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/** A person's click: Base UI's menus open on the press, a plain button on the click. */
function press(el: HTMLElement): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  el.click();
}

const pane = (root: ParentNode) => root.querySelector<HTMLElement>('section.ib-pane');

/** The open thread's ⋯ menu (a phone's sheet), swapped to its times. */
async function sheet(root: ParentNode): Promise<boolean> {
  const more = await until(() => pane(root)?.querySelector<HTMLElement>('[data-thread-more]'));
  if (!more) return false;
  press(more);
  const item = await until(() => root.querySelector<HTMLElement>('[data-thread-menu] [data-thread-snooze-item]'));
  if (!item) return false;
  press(item);
  return (await until(() => root.querySelector('[data-thread-menu] [data-snooze-choice]'))) !== null;
}

/** The row's right-click menu, swapped to its times. */
async function rowMenu(root: ParentNode, threadId: string): Promise<boolean> {
  const id = CSS.escape(threadId);
  const row = root.querySelector<HTMLElement>(`.ib-lbody [data-row="${id}"] [data-thread-id], .ib-lbody .ib-mrow[data-thread-id="${id}"]`);
  if (!row) return false;
  row.scrollIntoView?.({ block: 'nearest' });
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + Math.min(240, rect.width / 2), clientY: rect.top + rect.height / 2 }));
  const item = await until(() => root.querySelector<HTMLElement>(`[data-row-menu="${id}"] [data-row-action="snooze"]`));
  if (!item) return false;
  press(item);
  return (await until(() => root.querySelector(`[data-row-menu="${id}"] [data-snooze-choice]`))) !== null;
}

/** Open the real Snooze menu for Try it. True when it is on screen. */
export async function openSnoozeMenu(target: SnoozeTryTarget): Promise<boolean> {
  const { root, phone, openThread, left } = target;
  if (openThread) {
    if (await sheet(root)) return true;
    // That thread offers no Snooze (archived, say): the row just left, off a phone.
    return !phone && left !== null && left !== openThread ? rowMenu(root, left) : false;
  }
  if (!left) return false;
  if (!phone) return rowMenu(root, left);
  target.openLeft(left);
  return sheet(root);
}
