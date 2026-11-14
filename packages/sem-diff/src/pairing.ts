// Which function on one side is the same function on the other: the pairing the extract/inline
// check builds on. A function with a counterpart still exists (it was not inlined or extracted);
// one with a twin moved or was renamed. Each rule below is one way the same function shows up.
import { rule } from './runtime.ts';
import type { Node } from 'web-tree-sitter';
import type { LanguageConfig } from './parse.ts';
import { callsTo, dice, pairSameNamed, tokens, type FunctionInfo } from './syntax.ts';


export interface Pairing {
  /** The same function on the other side, if it still exists there. */
  counterpart(f: FunctionInfo): FunctionInfo | undefined;
  /** Its body reappears in another function on the other side: moved or renamed, not inlined. */
  hasTwin(f: FunctionInfo): boolean;
}

export function pairFunctions(oldFns: FunctionInfo[], newFns: FunctionInfo[], oldRoot: Node, newRoot: Node, cfg: LanguageConfig): Pairing {
  // Same function in both versions: same class (or receiver) and name, or, when the
  // class itself was renamed, the only function of that name on each side.
  // Overloads share a name: pair them by body similarity, not by order.
  // The overload that kept the old parameter list is the old function: when code moves
  // into a new, longer overload (`readFrom(in, funnel)` -> `readFrom(in, funnel, max)`),
  // body similarity alone would pair the old one with the overload now holding its code.
  const signature = (f: FunctionInfo) => {
    const p = tokens(f.node.childForFieldName('parameters') ?? f.node.childForFieldName('value')?.childForFieldName('parameters') ?? f.body).slice(0, 60);
    return [...p, ...p, ...p, ...tokens(f.body)];
  };
  // An overload that kept the old parameter list exactly is the old function, however
  // much its body changed: `consumeMessages(brokerUrl, topics)` became a wrapper around a
  // new `consumeMessages(consumer, topics)` that now holds the old body.
  const base = (f: FunctionInfo) => f.key.replace(/#\d+$/, '');
  const params = (f: FunctionInfo) => {
    const p = f.node.childForFieldName('parameters') ?? f.node.childForFieldName('value')?.childForFieldName('parameters');
    return p ? tokens(p).join(' ') : null;
  };
  const samePlace = (fs: FunctionInfo[], f: FunctionInfo) => fs.filter((g) => base(g) === base(f));
  const pinned: Array<[FunctionInfo, FunctionInfo]> = [];
  // Either way round: one function became several overloads, or several became one.
  for (const f of oldFns) {
    const p = params(f);
    const olds = samePlace(oldFns, f);
    const news = samePlace(newFns, f);
    if (p === null || olds.length > 1 || news.length < 2) continue;
    const same = news.filter((g) => params(g) === p);
    if (same.length === 1) pinned.push([f, same[0]!]);
  }
  for (const g of newFns) {
    const p = params(g);
    const olds = samePlace(oldFns, g);
    const news = samePlace(newFns, g);
    if (p === null || news.length > 1 || olds.length < 2) continue;
    const same = olds.filter((f) => params(f) === p);
    if (same.length === 1) pinned.push([same[0]!, g]);
  }
  // A body that reappears token for token under another name was renamed, even when a new
  // function took the old name (`run` -> `fly` and a new `run`; `comments` -> `reviewComments`
  // while `conversation` -> `comments`): pairing by name would set up a false extract and inline.
  // Only one-to-one identical bodies of some size, and only when the same-name partner differs.
  if (rule('SWAPPED_RENAMES')) {
    const text = (f: FunctionInfo) => tokens(f.body).join(' ');
    const sized = (f: FunctionInfo) => tokens(f.body).length >= 12;
    const group = (fs: FunctionInfo[]) => fs.filter(sized).reduce((m, f) => m.set(text(f), [...(m.get(text(f)) ?? []), f]), new Map<string, FunctionInfo[]>());
    const og = group(oldFns);
    const ng = group(newFns);
    const taken = new Set(pinned.flat());
    for (const [t, os] of og) {
      const ns = ng.get(t);
      if (os.length !== 1 || ns?.length !== 1) continue;
      const [f, g] = [os[0]!, ns[0]!];
      if (f.name === g.name || taken.has(f) || taken.has(g)) continue;
      const sameNameNew = newFns.filter((x) => base(x) === base(f));
      const sameNameOld = oldFns.filter((x) => base(x) === base(g));
      // Unless one side's same-name partner is just as identical (then it is a copy, not a rename).
      if ([...sameNameNew, ...sameNameOld].some((x) => text(x) === t)) continue;
      if (!sameNameNew.length && !sameNameOld.length) continue; // a plain rename: hasTwin handles it
      // A namesake that called the other one took its whole body: an inline (`entrySet()` that
      // called `createEntrySet()` now holds its body) or, the other way round, an extract.
      if (sameNameOld.some((x) => callsTo(x.node, f.name, cfg).length) || sameNameNew.some((x) => callsTo(x.node, g.name, cfg).length)) continue;
      pinned.push([f, g]);
      taken.add(f).add(g);
    }
  }
  const pinnedOld = new Set(pinned.map(([a]) => a));
  const pinnedNew = new Set(pinned.map(([, b]) => b));
  const byKey = new Map([
    ...pinned,
    ...pairSameNamed(oldFns.filter((f) => !pinnedOld.has(f)), newFns.filter((f) => !pinnedNew.has(f)), base, signature),
  ]);
  const count = (fs: FunctionInfo[]) => fs.reduce((m, f) => m.set(f.name, (m.get(f.name) ?? 0) + 1), new Map<string, number>());
  const oldCount = count(oldFns);
  const newCount = count(newFns);
  const newOnlyByName = new Map(newFns.filter((f) => newCount.get(f.name) === 1).map((f) => [f.name, f]));
  const counterpart = (f: FunctionInfo) =>
    byKey.get(f) ?? (oldCount.get(f.name) === 1 ? newOnlyByName.get(f.name) : undefined);
  // A function whose twin (same name, same body) is on the other side was moved or
  // had its class renamed; it was not inlined or extracted.
  // Likewise one whose body reappears in a new function under another name was renamed
  // (`entryIterator` -> `internalEntryIterator`, callers updated).
  const matched = new Set(oldFns.map((f) => counterpart(f)).filter((g): g is FunctionInfo => !!g));
  // A rename takes the old name away. When that name is still declared on this side (the
  // function was kept, say as a one-line arrow the pairing above does not see), its body
  // moving to a new function is an extract or inline, not a rename. (Mere references do
  // not count: callers elsewhere may keep calling the old name.)
  // Declarations are counted: overrides in several classes share a name, and renaming
  // some of them still takes declarations away.
  let declared: [Map<string, number>, Map<string, number>] | null = null;
  const stillNamed = (name: string) => {
    declared ??= [namesIn(oldRoot), namesIn(newRoot)];
    return (declared[0].get(name) ?? 0) >= (declared[1].get(name) ?? 0);
  };
  const hasTwin = (f: FunctionInfo) => {
    const t = tokens(f.body);
    return newFns.some((g) => {
      // Same name, same body: moved. Unless that function is still paired with another one
      // here (it kept its signature as a wrapper): then the body went into a new overload.
      if (g.name === f.name) return !matched.has(g) && dice(tokens(g.body), t) >= 0.9;
      // Renamed and lightly edited on the way (`IsSafe` -> `Validate`, 0.82 alike).
      return !matched.has(g) && t.length >= 8 && dice(tokens(g.body), t) >= 0.8 && !stillNamed(g.name);
    });
  };

  return { counterpart, hasTwin };
}

/** How often the tree declares each name (a leaf that is its parent's `name` field). */
function namesIn(root: Node): Map<string, number> {
  const out = new Map<string, number>();
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.childCount === 0) {
      if (n.parent?.childForFieldName('name')?.id === n.id) out.set(n.text, (out.get(n.text) ?? 0) + 1);
      continue;
    }
    for (const c of n.children) if (c) stack.push(c);
  }
  return out;
}
