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
  /**
   * For a changed thing: what it was and what it became, in the few facts "what changed" is said from. Several
   * revisions of one thing (a drag is saved more than once) are told as the one change from the first `was` to the
   * last `now`.
   */
  was?: ThingFacts;
  now?: ThingFacts;
}

/** What "what changed" is judged by: place and size, words, colours, frame, ends, and a sketch's stroke count. */
export interface ThingFacts {
  kind: string;
  box: [number, number, number, number];
  words: string;
  stroke: string;
  fill: string;
  frame: string;
  from: string;
  to: string;
  strokes?: number;
}

const factsOf = (t: Thing): ThingFacts => ({
  kind: t.kind,
  box: [Math.round(t.box.x), Math.round(t.box.y), Math.round(t.box.w), Math.round(t.box.h)],
  words: t.words,
  stroke: t.stroke,
  fill: t.fill,
  frame: t.frame ?? '',
  from: t.from?.id ?? '',
  to: t.to?.id ?? '',
  ...(t.strokes !== undefined ? { strokes: t.strokes } : {}),
});

/** What the person kept when they took back an agent's change, and what went back (the Undo's log entry). Each is a list of things by kind and words. */
export interface CanvasUndone {
  /** Back as they were before the agent's change. */
  back: string[];
  /** Partly back: the person had changed them since, and what they changed stays theirs. */
  part: string[];
  /** Not taken back at all: the person had changed them since. */
  kept: string[];
  /** Things the agent had added, now removed. */
  gone: string[];
}

export interface CanvasLogEntry {
  rev: number;
  at: string;
  by: CanvasAuthor;
  changes: CanvasChange[];
  /** The person took back the change of this revision (the window's Undo on an agent's change). */
  undid?: number;
  /** With `undid`: exactly what went back and what the person kept. */
  undone?: CanvasUndone;
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

/** What changed between two states of a thing, as verbs: "moved", "resized", "renamed", "recoloured", "reconnected", "rerouted", "drew on", "partly erased", "moved into <frame>", "taken out of its frame". `detail`: with from and to ("moved from 10,20 to 300,40", "renamed "Pick a plan" → "Choose a plan""). */
export function whatChanged(a: ThingFacts, b: ThingFacts, detail = false): string {
  const parts: string[] = [];
  const moved = Math.abs(a.box[0] - b.box[0]) > 1 || Math.abs(a.box[1] - b.box[1]) > 1;
  const resized = Math.abs(a.box[2] - b.box[2]) > 1 || Math.abs(a.box[3] - b.box[3]) > 1;
  const cut = (words: string) => JSON.stringify(Array.from(words).length > 80 ? `${Array.from(words).slice(0, 79).join('')}…` : words);
  const connector = a.kind === 'arrow' || a.kind === 'line';
  if (a.kind === 'sketch' && a.strokes !== b.strokes) parts.push(`${(b.strokes ?? 0) > (a.strokes ?? 0) ? 'drew on' : 'partly erased'}`);
  else if (resized && moved && connector) parts.push('rerouted');
  else {
    if (moved) parts.push(detail && !connector ? `moved from ${a.box[0]},${a.box[1]} to ${b.box[0]},${b.box[1]}` : 'moved');
    if (resized) parts.push(detail ? `resized from ${a.box[2]}x${a.box[3]} to ${b.box[2]}x${b.box[3]}` : 'resized');
  }
  if (a.words !== b.words) parts.push(!detail ? 'renamed' : !a.words ? `labelled ${cut(b.words)}` : !b.words ? `cleared the words ${cut(a.words)}` : `renamed ${cut(a.words)} → ${cut(b.words)}`);
  if (a.stroke !== b.stroke || a.fill !== b.fill) {
    const look = (f: ThingFacts) => [f.stroke, f.fill && f.fill !== f.stroke ? `filled ${f.fill}` : ''].filter(Boolean).join(', ') || 'no colour';
    parts.push(detail ? `recoloured from ${look(a)} to ${look(b)}` : 'recoloured');
  }
  if (a.from !== b.from || a.to !== b.to) parts.push(detail ? `reconnected, was ${a.from || '(open)'} -> ${a.to || '(open)'}` : 'reconnected');
  if (a.frame !== b.frame) parts.push(b.frame ? `moved into ${b.frame}` : 'taken out of its frame');
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
        const said = whatChanged(factsOf(was), factsOf(now));
        // Nothing a reader would see differs (the editor only re-stamped the element): not a change.
        if (!said && lineOf(was, prev, before) === lineOf(now, next, after)) continue;
        // A text's size is the editor's measure of its words (it wraps and measures them when a window opens): not a change anyone made.
        if (now.kind === 'text' && was.words === now.words && (!said || said === 'resized')) continue;
        const what = said || 'edited';
        // An arrow that only followed the thing it is attached to is not news.
        if (what === 'rerouted' && (now.from?.attached || now.to?.attached)) continue;
        changes.push({ thing: now.id, op: 'changed', what, line: lineOf(now, next, after), elements, was: factsOf(was), now: factsOf(now) });
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
): { lines: string[]; elements: Set<string>; byElement: Map<string, { by: CanvasAuthor; change: CanvasChange; rev: number }>; through: number; cut: boolean; undone: CanvasLogEntry[]; saves: string } {
  // Per thing and author: the first change since the agent looked and the last. What is told is the one change between them.
  const last = new Map<string, { by: CanvasAuthor; first: CanvasChange; change: CanvasChange; rev: number; parts: string[] }>();
  const byElement = new Map<string, { by: CanvasAuthor; change: CanvasChange; rev: number }>();
  const undone: CanvasLogEntry[] = [];
  const savesBy = new Map<string, number>();
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
    savesBy.set(authorWords(entry.by), (savesBy.get(authorWords(entry.by)) ?? 0) + 1);
    // The person took back a change of this agent's: said in its own line (the server words it).
    if (entry.undid !== undefined && me) {
      const made = log.find((e) => e.rev === entry.undid);
      if (made && sameAuthor(made.by, me)) undone.push(entry);
    }
    for (const change of entry.changes) {
      const key = `${entry.by.kind}:${entry.by.key ?? entry.by.name ?? ''}:${change.elements.slice().sort()[0] ?? change.thing}`;
      const prior = last.get(key);
      const parts = prior?.parts ?? [];
      if (change.op === 'changed') for (const part of (change.what ?? 'edited').split(', ')) if (!parts.includes(part)) parts.push(part);
      last.set(key, { by: entry.by, first: prior?.first ?? change, change, rev: entry.rev, parts });
      for (const id of change.elements) byElement.set(id, { by: entry.by, change, rev: entry.rev });
    }
  }
  const elements = new Set<string>(byElement.keys());
  const said: { added: boolean; line: string }[] = [];
  for (const item of last.values()) {
    const born = item.first.op === 'added';
    const gone = item.change.op === 'removed';
    // Added and removed again between two looks: the agent never saw it, and there is nothing to see.
    if (born && gone) continue;
    let ops: string;
    if (gone) ops = 'removed';
    else if (born) ops = 'added';
    else if (item.first.op === 'removed') ops = 'removed and brought back';
    else if (item.first.was && item.change.now) {
      // One drag saved three times is one move; a colour changed and changed back is no change.
      ops = whatChanged(item.first.was, item.change.now, true);
      if (!ops) {
        if (JSON.stringify(item.first.was) === JSON.stringify(item.change.now)) continue;
        ops = 'edited';
      }
    } else ops = item.parts.join(', ') || 'edited';
    said.push({ added: born, line: `  ${authorWords(item.by)} ${ops}: ${item.change.line}` });
  }
  const lines = [...said.filter((x) => !x.added), ...said.filter((x) => x.added)].map((x) => x.line);
  // Every save is one revision, so the number jumps: "3 changes by the person" says why.
  const saves = [...savesBy].map(([who, n]) => `${n} change${n === 1 ? '' : 's'} by ${who}`).join(', ');
  return { lines, elements, byElement, through, cut, undone, saves };
}

/** The line an agent's answer opens with when the person took back one of its changes: exactly what went back and what they kept. */
export function undoneLine(entry: CanvasLogEntry): string {
  const u = entry.undone;
  const head = `The person undid your change (rev ${entry.undid})`;
  if (!u) return `${head}.`;
  const list = (names: string[]) => `${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}`;
  const parts = [
    u.back.length > 0 ? `Back as before: ${list(u.back)}.` : '',
    u.gone.length > 0 ? `Removed (you had added ${u.gone.length === 1 ? 'it' : 'them'}): ${list(u.gone)}.` : '',
    u.part.length > 0 ? `Partly back, with the person's own later change kept: ${list(u.part)}.` : '',
    u.kept.length > 0 ? `Not undone, because the person changed ${u.kept.length === 1 ? 'it' : 'them'} since: ${list(u.kept)}.` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `${head}. ${parts.join(' ')}` : `${head}.`;
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
