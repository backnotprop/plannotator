/**
 * A linked computer's canvas saves (CanvasBoard.tsx), the parts that need no editor: what a save names, and the
 * pieces it goes in.
 *
 * A save of a linked computer's thread goes through this Inbox's outbox. Each save goes there at once, naming only
 * what no save waiting for that computer carries, and the outbox folds it into the one that waits and has not left
 * (packages/server/inbox-canvas-fold.ts). So minutes of drawing while that computer is away are one entry, not one
 * per pause, and nothing of it waits only in the editor.
 */

import type { MachineView, OutboxView } from '../api';
import { outboxLine, outboxPending } from '../machines';

/** An element as the editor and the Inbox both hold it: enough to compare and to measure. */
export interface FarElement {
  id: string;
  type?: string;
  isDeleted?: boolean;
  fileId?: unknown;
}

/** A save waiting in the outbox: each element it carries (as `sig` gave it) and the ids it removes. */
export interface HeldSave {
  sent: ReadonlyMap<string, string>;
  gone: readonly string[];
}

/**
 * The outbox holds at most 256 KB of JSON per write (OUTBOX_MAX_BODY_BYTES in packages/server/inbox-outbox.ts). A
 * part stays well under it with the save's other fields; one element larger than this goes as a part of its own,
 * which the forward sends at once while that computer is online.
 */
export const FAR_PART_CHARS = 200_000;

/**
 * What a save of a linked computer's thread names now: each element that differs from what that computer has
 * (`synced`), unless a save waiting for it carries it as it is now, or it is a picture whose file has not gone yet
 * (`waiting`: its file goes first, and that computer is away); and each id the editor no longer holds that no waiting
 * save removes. `pictures`: how many are held back for their files.
 */
export function farChanges<E extends FarElement>(
  elements: readonly E[],
  synced: ReadonlyMap<string, string>,
  held: Iterable<HeldSave>,
  waiting: ReadonlySet<string>,
  sig: (el: E) => string,
): { elements: E[]; gone: string[]; pictures: number } {
  const carried = new Map<string, Set<string>>();
  const removing = new Set<string>();
  for (const save of held) {
    for (const [id, value] of save.sent) carried.set(id, (carried.get(id) ?? new Set()).add(value));
    for (const id of save.gone) removing.add(id);
  }
  let pictures = 0;
  const out: E[] = [];
  for (const el of elements) {
    const now = sig(el);
    if (synced.get(el.id) === now || carried.get(el.id)?.has(now)) continue;
    if (!el.isDeleted && el.type === 'image' && typeof el.fileId === 'string' && waiting.has(el.fileId)) {
      pictures++;
      continue;
    }
    out.push(el);
  }
  const present = new Set(elements.map((e) => e.id));
  const gone = [...synced.keys()].filter((id) => !present.has(id) && !removing.has(id));
  return { elements: out, gone, pictures };
}

/** One save in parts, in order, each under `max` characters of JSON; nothing to send is no part. */
export function farParts<E>(elements: readonly E[], gone: readonly string[], max = FAR_PART_CHARS): { elements: E[]; gone: string[] }[] {
  const parts: { elements: E[]; gone: string[] }[] = [];
  let part: { elements: E[]; gone: string[] } = { elements: [], gone: [] };
  let size = 0;
  const add = (cost: number, put: (into: typeof part) => void) => {
    if (size > 0 && size + cost > max) {
      parts.push(part);
      part = { elements: [], gone: [] };
      size = 0;
    }
    put(part);
    size += cost;
  };
  for (const el of elements) add(JSON.stringify(el).length + 1, (into) => into.elements.push(el));
  for (const id of gone) add(id.length + 3, (into) => into.gone.push(id));
  if (size > 0) parts.push(part);
  return parts;
}

/** Two saves the outbox holds as one (a save made while one waits is folded into it there): what both carry. */
export function joinHeld(held: HeldSave | undefined, next: HeldSave): HeldSave {
  if (!held) return next;
  const sent = new Map([...held.sent, ...next.sent]);
  return { sent, gone: [...new Set([...held.gone, ...next.gone])].filter((id) => !sent.has(id)) };
}

/**
 * How a save or an Undo held for a linked computer ended, by its outbox entry: null while it waits; landed; or why it
 * did not, in the outbox's words (said as an error: refused there, the link removed, given up after its errors).
 * `seen`: the window's outbox listed it before. One it no longer lists (read again whole after a reconnect: only what
 * waits and what did not land) has ended, how is not known here: not landed, and nothing to say.
 */
export function heldEnd(entry: OutboxView | undefined, machine: Pick<MachineView, 'name' | 'state'> | null, seen = false): null | { landed: true } | { landed: false; words: string } | { landed: false; unknown: true } {
  if (!entry) return seen ? { landed: false, unknown: true } : null;
  if (outboxPending(entry)) return null;
  if (entry.state === 'delivered') return { landed: true };
  // A link removed takes the machine with it: the entry keeps its name.
  const named = machine ?? (entry.machine_name ? { name: entry.machine_name, state: 'offline' as const } : null);
  return { landed: false, words: outboxLine(entry, named)?.text ?? `Not delivered to ${named?.name ?? 'the other machine'}.` };
}
