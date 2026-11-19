import { lineOf, thingsOf, type Thing } from './reading';
import type { CanvasElement, CanvasScene } from './scene';

/**
 * What changed between two states of a canvas, said per thing ("moved",
 * "new words"), and the merge of a person's save into the stored scene.
 *
 * Every save is one revision. The log of them is how an agent's answer can
 * open with what the person changed since it last looked, and how the Inbox
 * refuses an agent's change to something the person changed meanwhile.
 */
export interface CanvasAuthor {
  kind: 'person' | 'agent';
  /** An agent's name as the Inbox shows it, and what tells one agent session from another. */
  name?: string;
  key?: string;
}

export interface CanvasChange {
  /** The thing's id in the reading after the change (before it, for a removed thing). */
  thing: string;
  op: 'added' | 'changed' | 'removed';
  /** For a changed thing: "moved", "resized", "new words", "new colour", or "edited". */
  what?: string;
  /** The thing's line in the reading after the change (before it, for a removed thing). */
  line: string;
  /** The Excalidraw elements of it that differ. */
  elements: string[];
}

export interface CanvasLogEntry {
  rev: number;
  at: string;
  by: CanvasAuthor;
  changes: CanvasChange[];
  /** The person took back the change of this revision (the window's Undo on an agent's change). */
  undid?: number;
}

const same = (a: CanvasElement | undefined, b: CanvasElement | undefined) =>
  !!a && !!b && (a.version ?? 0) === (b.version ?? 0) && (a.versionNonce ?? 0) === (b.versionNonce ?? 0) && !!a.isDeleted === !!b.isDeleted;

/** The element ids that differ between two scenes (added, changed, deleted). */
export function changedElements(prev: CanvasScene, next: CanvasScene): Set<string> {
  const before = new Map(prev.elements.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const el of next.elements) {
    const old = before.get(el.id);
    if (!old ? !el.isDeleted : !same(old, el)) out.add(el.id);
    before.delete(el.id);
  }
  for (const [id, old] of before) if (!old.isDeleted) out.add(id);
  return out;
}

function whatChanged(a: Thing, b: Thing): string {
  const parts: string[] = [];
  const moved = Math.abs(a.box.x - b.box.x) > 1 || Math.abs(a.box.y - b.box.y) > 1;
  const resized = Math.abs(a.box.w - b.box.w) > 1 || Math.abs(a.box.h - b.box.h) > 1;
  if (a.kind === 'sketch' && a.strokes !== b.strokes) parts.push(`${(b.strokes ?? 0) > (a.strokes ?? 0) ? 'drawn on' : 'partly erased'}`);
  else if (resized) parts.push(moved && (a.kind === 'arrow' || a.kind === 'line') ? 'rerouted' : 'resized');
  else if (moved) parts.push('moved');
  if (a.words !== b.words) parts.push('new words');
  if (a.stroke !== b.stroke || a.fill !== b.fill) parts.push('new colour');
  if ((a.from?.id ?? '') !== (b.from?.id ?? '') || (a.to?.id ?? '') !== (b.to?.id ?? '')) parts.push('new ends');
  if ((a.frame ?? '') !== (b.frame ?? '')) parts.push(b.frame ? `now in ${b.frame}` : 'out of its frame');
  return parts.join(', ');
}

export function diffScenes(prev: CanvasScene, next: CanvasScene): CanvasChange[] {
  const ids = changedElements(prev, next);
  if (ids.size === 0) return [];
  const before = thingsOf(prev);
  const after = thingsOf(next);
  const beforeOf = new Map<string, Thing>();
  for (const t of before) for (const id of t.elementIds) beforeOf.set(id, t);
  const afterOf = new Map<string, Thing>();
  for (const t of after) for (const id of t.elementIds) afterOf.set(id, t);
  const changes: CanvasChange[] = [];
  const seenAfter = new Set<Thing>();
  const seenBefore = new Set<Thing>();
  for (const id of ids) {
    const now = afterOf.get(id);
    if (now) {
      if (seenAfter.has(now)) continue;
      seenAfter.add(now);
      const was = now.elementIds.map((e) => beforeOf.get(e)).find(Boolean);
      const elements = now.elementIds.filter((e) => ids.has(e));
      if (was) seenBefore.add(was);
      if (!was) changes.push({ thing: now.id, op: 'added', line: lineOf(now, next, after), elements });
      else {
        const said = whatChanged(was, now);
        // Nothing a reader would see differs (the editor only re-stamped the element): not a change.
        if (!said && lineOf(was, prev, before) === lineOf(now, next, after)) continue;
        const what = said || 'edited';
        // An arrow that only followed the thing it is attached to is not news.
        if (what === 'rerouted' && (now.from?.attached || now.to?.attached)) continue;
        changes.push({ thing: now.id, op: 'changed', what, line: lineOf(now, next, after), elements });
      }
    }
  }
  for (const id of ids) {
    if (afterOf.has(id)) continue;
    const was = beforeOf.get(id);
    if (!was || seenBefore.has(was)) continue;
    seenBefore.add(was);
    if (was.elementIds.some((e) => afterOf.has(e))) continue;
    changes.push({ thing: was.id, op: 'removed', line: lineOf(was, prev, before), elements: was.elementIds });
  }
  return changes;
}

/** The same actor: the person, or the same agent session. An agent call with no session is nobody in particular, so it is never the same as another (two unnamed callers must not pass for one). */
export const sameAuthor = (a: CanvasAuthor, b: CanvasAuthor) => a.kind === b.kind && (a.kind === 'person' || (!!a.key && a.key === b.key));

export const authorWords = (by: CanvasAuthor) => (by.kind === 'person' ? 'the person' : by.name || 'another agent');

/**
 * What others changed after a revision, newest state per thing, as the lines
 * an answer opens with: edits and removals first, new things last, so a pile
 * of additions never pushes an edit out of view. Empty when nothing did.
 *
 * `through`: the last revision whose changes are all in the lines. When the
 * list had to be cut, it is the revision before the first one left out, and
 * the agent's point moves only that far: what it was not told, it is told on
 * its next call.
 */
export function sinceLines(
  log: CanvasLogEntry[],
  rev: number,
  me: CanvasAuthor | null,
  max = 30,
): { lines: string[]; elements: Set<string>; byElement: Map<string, { by: CanvasAuthor; change: CanvasChange; rev: number }>; through: number; cut: boolean; undone: number[] } {
  const last = new Map<string, { by: CanvasAuthor; change: CanvasChange; rev: number; ops: Set<string> }>();
  const byElement = new Map<string, { by: CanvasAuthor; change: CanvasChange; rev: number }>();
  const undone: number[] = [];
  let through = rev;
  let cut = false;
  for (const entry of log) {
    if (entry.rev <= rev) continue;
    if (me && sameAuthor(entry.by, me)) {
      if (!cut) through = entry.rev;
      continue;
    }
    // A whole revision is told or none of it; the first one always is, however long.
    const fresh = entry.changes.filter((change) => !last.has(`${entry.by.kind}:${entry.by.key ?? entry.by.name ?? ''}:${change.elements.slice().sort()[0] ?? change.thing}`)).length;
    if (cut || (last.size > 0 && last.size + fresh > max)) {
      cut = true;
      continue;
    }
    through = entry.rev;
    // The person took back a change of this agent's: said in its own line (the server words it).
    if (entry.undid !== undefined && me) {
      const made = log.find((e) => e.rev === entry.undid);
      if (made && sameAuthor(made.by, me)) undone.push(entry.undid);
    }
    for (const change of entry.changes) {
      const key = `${entry.by.kind}:${entry.by.key ?? entry.by.name ?? ''}:${change.elements.slice().sort()[0] ?? change.thing}`;
      const prior = last.get(key);
      const ops = prior?.ops ?? new Set<string>();
      ops.add(change.op === 'changed' ? change.what ?? 'edited' : change.op);
      last.set(key, { by: entry.by, change, rev: entry.rev, ops });
      for (const id of change.elements) byElement.set(id, { by: entry.by, change, rev: entry.rev });
    }
  }
  const elements = new Set<string>(byElement.keys());
  const said = [...last.values()].map((item) => {
    const added = item.ops.has('added') && item.change.op !== 'removed';
    const ops = added ? 'added' : item.change.op === 'removed' ? 'removed' : [...item.ops].join(', ');
    return { added, line: `  ${authorWords(item.by)} ${ops}: ${item.change.line}` };
  });
  const lines = [...said.filter((x) => !x.added), ...said.filter((x) => x.added)].map((x) => x.line);
  return { lines, elements, byElement, through, cut, undone };
}

const TOMBSTONE_DAYS = 7;

/**
 * A person's save from the window into the stored scene. The window sends
 * everything it holds, deleted elements included, so an element it does not
 * name is one it never had (an agent added it meanwhile) and stays. For an
 * element both hold, the higher version wins, and the person wins a tie: an
 * agent's change never silently replaces what the person just did.
 */
export function mergeSave(stored: CanvasScene, incoming: CanvasScene, now: number): { scene: CanvasScene; kept: number } {
  const theirs = new Map(incoming.elements.map((e) => [e.id, e]));
  const out: CanvasElement[] = [];
  let kept = 0;
  const seen = new Set<string>();
  // The window's order first (it is the drawing order the person sees), then what only the store has.
  const mine = new Map(stored.elements.map((e) => [e.id, e]));
  for (const el of incoming.elements) {
    if (seen.has(el.id)) continue;
    seen.add(el.id);
    const old = mine.get(el.id);
    if (old && (old.version ?? 0) > (el.version ?? 0)) {
      out.push(old);
      kept++;
    } else out.push(el);
  }
  for (const el of stored.elements) {
    if (theirs.has(el.id)) continue;
    // Keep its place in the drawing order: after the stored element before it.
    const index = stored.elements.indexOf(el);
    const before = index > 0 ? stored.elements[index - 1]!.id : null;
    const at = before ? out.findIndex((e) => e.id === before) : -1;
    out.splice(at + 1, 0, el);
    if (!el.isDeleted) kept++;
  }
  const cutoff = now - TOMBSTONE_DAYS * 86_400_000;
  const live = out.filter((e) => !e.isDeleted || (e.updated ?? now) > cutoff);
  // Pictures' bytes are kept apart, once each, for as long as the canvas lives (store.ts): a picture deleted and
  // brought back by Undo, or by the person taking back an agent's change, still has its file. What the window sends
  // new rides along to be written.
  const files: Record<string, unknown> = { ...stored.files, ...incoming.files };
  return { scene: { ...stored, source: incoming.source || stored.source, elements: live, appState: { ...stored.appState, ...incoming.appState }, files }, kept };
}
