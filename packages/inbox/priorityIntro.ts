/**
 * The one-time Priority dialog (reveals.ts `priority`), the window's side. The Inbox decides who (3 days of use, 8
 * threads, never added a thread to Priority: packages/server/inbox-priority-intro.ts) and the day (`reveal.next`);
 * the page decides the moment: the shared calm moment (a thread read 5 s and left, or the page idle), 60 s into the
 * page, on the grouped list (List view draws no Priority group), with 3 threads or more waiting on the person, so
 * that order matters.
 *
 * Try it opens the REAL menu with focus on Add to Priority, as the person's own right-click or ⋯ would, and stops
 * there: it never adds anything by itself.
 *  - A thread open: its ⋯ menu (a phone's ⋯ sheet).
 *  - No thread open, off a phone: the right-click menu of the thread last opened.
 *  - No thread open, on a phone: that thread opens again, then its ⋯ sheet.
 */
import { INBOX_SECTIONS, inboxRowArchived, type InboxListRow } from '@plannotator/core/inbox-types';
import { REVEAL_TIMES } from './reveal';
import { snoozeIntroWaits } from './snoozeIntroRows';

/** Fewer threads than this waiting on the person: order hardly matters yet, so the dialog waits. */
export const PRIORITY_INTRO_MIN_WAITING = 3;

const waits = (row: InboxListRow) => snoozeIntroWaits(row) && !inboxRowArchived(row);

/** Threads that wait on the person now (not snoozed, not archived). */
export function priorityIntroWaiting(rows: readonly InboxListRow[]): number {
  return rows.filter(waits).length;
}

export interface PriorityIntroGate {
  listLoaded: boolean;
  firstRun: boolean;
  /** The list draws its groups (Smart groups): the flat List view has no Priority group to point at. */
  grouped: boolean;
  rows: readonly InboxListRow[];
}

/**
 * Its need at a settled moment: an Inbox that keeps priority (rows carry the key), nothing in Priority by the person
 * yet, enough threads waiting, the grouped list, 60 s into the page.
 */
export function priorityIntroMayClaim(gate: PriorityIntroGate, pageAge: number): boolean {
  if (!gate.listLoaded || gate.firstRun || !gate.grouped || pageAge < REVEAL_TIMES.pageAgeMs) return false;
  if (!gate.rows.some((row) => row.priority !== undefined)) return false;
  return priorityIntroHolds(gate.rows) && priorityIntroWaiting(gate.rows) >= PRIORITY_INTRO_MIN_WAITING;
}

/** Still worth showing: the person has not added a thread to Priority meanwhile (on this page or another). */
export function priorityIntroHolds(rows: readonly InboxListRow[]): boolean {
  return !rows.some((row) => row.priority?.person === true);
}

/** The thread Try it aims at: the one last opened (the moment's), else the newest thread waiting on the person. */
export function priorityIntroTarget(rows: readonly InboxListRow[], left: string | null): string | null {
  if (left && rows.some((row) => row.thread_id === left && !inboxRowArchived(row))) return left;
  return rows.find(waits)?.thread_id ?? null;
}

export interface PriorityIntroPicture {
  /** The thread the menu is aimed at, drawn where it lands: first, in Priority. */
  landed: InboxListRow;
  /** A thread under it, in its own group, so the picture shows Priority above the rest; null with one row. */
  below: { row: InboxListRow; label: string } | null;
}

/** The picture's rows: the target drawn in Priority, and the next waiting thread in its own group under it. */
export function priorityIntroPicture(rows: readonly InboxListRow[], target: string | null): PriorityIntroPicture | null {
  const aimed = rows.find((row) => row.thread_id === target) ?? rows.find(waits);
  if (!aimed) return null;
  const landed: InboxListRow = { ...aimed, priority: { person: true, at: new Date().toISOString(), ask: null } };
  const next = rows.find((row) => row.thread_id !== aimed.thread_id && waits(row));
  const label = next ? INBOX_SECTIONS.find((section) => section.id === next.section)?.label : undefined;
  return { landed, below: next && label ? { row: next, label } : null };
}

export interface PriorityTryTarget {
  /** Where the window is drawn (`.pn-inbox`, or the document). */
  root: ParentNode;
  phone: boolean;
  /** The thread open now, or null. */
  openThread: string | null;
  /** The thread last opened (`priorityIntroTarget`), or null. */
  target: string | null;
  /** Open a thread (a phone with none open). */
  openTarget: (threadId: string) => void;
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

/** A person's click: Base UI's menus open on the press, a plain button on the click. */
function press(el: HTMLElement): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  el.click();
}

/** Focus lands on the item the way a keyboard would put it there, so the menu draws it highlighted. */
async function focusItem(find: () => HTMLElement | null): Promise<boolean> {
  const item = await until(find);
  if (!item) return false;
  item.focus();
  return true;
}

const pane = (root: ParentNode) => root.querySelector<HTMLElement>('section.ib-pane');

async function threadMenu(root: ParentNode): Promise<boolean> {
  const more = await until(() => pane(root)?.querySelector<HTMLElement>('[data-thread-more]'));
  if (!more) return false;
  press(more);
  return focusItem(() => root.querySelector<HTMLElement>('[data-thread-menu] [data-thread-priority-item]'));
}

async function rowMenu(root: ParentNode, threadId: string): Promise<boolean> {
  const id = CSS.escape(threadId);
  const row = root.querySelector<HTMLElement>(`.ib-lbody [data-row="${id}"] [data-thread-id], .ib-lbody .ib-mrow[data-thread-id="${id}"]`);
  if (!row) return false;
  row.scrollIntoView?.({ block: 'nearest' });
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + Math.min(240, rect.width / 2), clientY: rect.top + rect.height / 2 }));
  return focusItem(() => root.querySelector<HTMLElement>(`[data-row-menu="${id}"] [data-row-action="priority-add"]`));
}

/** Open the real menu for Try it, focus on Add to Priority. True when it is on screen. */
export async function openPriorityMenu(target: PriorityTryTarget): Promise<boolean> {
  const { root, phone, openThread } = target;
  if (openThread) return threadMenu(root);
  if (!target.target) return false;
  if (!phone) return rowMenu(root, target.target);
  target.openTarget(target.target);
  return threadMenu(root);
}
