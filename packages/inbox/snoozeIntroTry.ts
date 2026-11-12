export interface SnoozeTryTarget {
  root: ParentNode;
  phone: boolean;
  openThread: string | null;
  left: string | null;
  openLeft: (threadId: string) => void;
}

const WAIT_MS = 2500;

async function until<T>(find: () => T | null | undefined, ms = WAIT_MS): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > end) return null;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function press(el: HTMLElement): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  el.click();
}

const pane = (root: ParentNode) => root.querySelector<HTMLElement>('section.ib-pane');

async function sheet(root: ParentNode): Promise<boolean> {
  const more = await until(() => pane(root)?.querySelector<HTMLElement>('[data-thread-more]'));
  if (!more) return false;
  press(more);
  const item = await until(() => root.querySelector<HTMLElement>('[data-thread-menu] [data-thread-snooze-item]'));
  if (!item) return false;
  press(item);
  return (await until(() => root.querySelector('[data-thread-menu] [data-snooze-choice]'))) !== null;
}

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

export async function openSnoozeMenu(target: SnoozeTryTarget): Promise<boolean> {
  const { root, phone, openThread, left } = target;
  if (openThread) {
    if (await sheet(root)) return true;
    return !phone && left !== null && left !== openThread ? rowMenu(root, left) : false;
  }
  if (!left) return false;
  if (!phone) return rowMenu(root, left);
  target.openLeft(left);
  return sheet(root);
}
