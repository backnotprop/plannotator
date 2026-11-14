// Declaration-level changes: moved, renamed, reformatted.
//
// 1. Collect named declarations in both versions (functions, classes, members, ...).
// 2. Pair them: by kind + name first, then unmatched leftovers whose code is
//    identical apart from the name (renamed declarations).
// 3. Within each container, pairs that left their relative order are moved
//    (longest increasing subsequence keeps the most code in place).
// 4. Names that change consistently everywhere become one `renamed` operation.
// 5. Paired declarations with identical tokens and comments but different
//    text are `reformatted`.
import type { Node } from 'web-tree-sitter';
import { isComment, type Declaration, type LanguageConfig } from './parse.ts';
import { rule } from './runtime.ts';
import type {
  SemanticDiffFold,
  SemanticDiffLinePair,
  SemanticDiffOperation,
  SemanticDiffTextRange,
} from './pierre-types.ts';
import { attachedAbove, endLine, keepWeights, longestInOrder, pairSameNamed, range, rangeOf, startLine } from './syntax.ts';

interface Entity {
  decl: Declaration;
  key: string;
  /** Kind and name within the parent, without the `#n` that numbers repeats. */
  base: string;
  parent: string;
  tokens: string[];
  identifiers: Node[];
  comments: string[];
  /** Tokens and comments in source order: equal means only whitespace changed. */
  seq: string;
  text: string;
}

export interface StructureResult {
  operations: SemanticDiffOperation[];
  folds: SemanticDiffFold[];
  /** Old-side lines (doc comments included) of every declaration paired across versions. */
  paired: Array<{ start: number; end: number }>;
}

function leaves(n: Node, cfg: LanguageConfig) {
  const tokens: string[] = [];
  const identifiers: Node[] = [];
  const comments: string[] = [];
  // `seq` also records the tree's shape: equal tokens can still parse differently
  // (`return x` vs `return` + newline + `x`, where an automatic semicolon or Go's
  // newline rule changes the meaning), and formatting never changes the tree.
  const seq: string[] = [];
  // Iterative: very deep trees (generated or fuzzed code) would overflow the stack.
  const stack: Array<Node | null> = [n];
  while (stack.length) {
    const x = stack.pop();
    if (x === null) {
      seq.push('\u0003');
      continue;
    }
    if (!x) continue;
    if (isComment(x)) {
      comments.push(x.text.trim());
      seq.push(x.text.trim());
      continue;
    }
    const ts = cfg.id === 'typescript' || cfg.id === 'tsx';
    if (ts && prettierOnly(x)) {
      // Tokens a formatter adds or drops without changing the code: kept as tokens, left out of the shape.
      if (x.childCount === 0) tokens.push(x.text);
      else for (let i = x.childCount - 1; i >= 0; i--) { const c = x.child(i); if (c && c.isNamed) stack.push(c); else if (c) tokens.push(c.text); }
      continue;
    }
    if (x.childCount === 0) {
      // A written `;` ending a JS/TS statement equals an inserted one; where the
      // line break would split the statement differently, the tree shape differs.
      const terminator = SAME_QUOTES.has(cfg.id) && cfg.id !== 'python' && x.type === ';' && x.parent?.lastChild?.startIndex === x.startIndex && /statement|declaration/.test(x.parent.type);
      if (terminator) tokens.push(x.text);
      else if (x.text.length) {
        tokens.push(x.text);
        // 'a' and "a" are the same string where both quote styles mean the same (TS, Python).
        seq.push(SAME_QUOTES.has(cfg.id) && (x.text === "'" || x.text === '"') && x.parent?.type === 'string' ? '\u0004quote' : x.text);
      } else seq.push(x.type === ';' ? ';' : `\u0001${x.type}`); // zero-width: an inserted semicolon equals a written one
      if (cfg.identifierTypes.has(x.type)) identifiers.push(x);
      // `return` (or `yield`, `break`, `continue`) and a line break ends the statement in
      // JS/TS, whatever follows; the parser does not always show it (`return` + newline + JSX).
      const next = x.nextSibling;
      if ((cfg.id === 'typescript' || cfg.id === 'tsx') && /^(return|yield|break|continue)$/.test(x.type) && next && next.type !== ';' && next.startPosition.row > x.endPosition.row) seq.push('\u0005break');
      continue;
    }
    seq.push(`\u0002${x.type}`);
    stack.push(null);
    for (let i = x.childCount - 1; i >= 0; i--) stack.push(x.child(i));
  }
  return { tokens, identifiers, comments, seq: withoutTrailingCommas(seq).join('\u0000') };
}

/**
 * Formatter-only syntax in TypeScript/JavaScript, which Prettier adds or removes:
 * - a leading `|` or `&` on a wrapped union or intersection type;
 * - parentheses around a lone arrow parameter (`x => x` / `(x) => x`) and around JSX;
 * - `;` or `,` separating interface, object-type and class members (a line break does the same).
 * A wrapper node returns true to be walked through without its own marker or punctuation.
 */
function prettierOnly(x: Node): boolean {
  const p = x.parent;
  if (x.childCount === 0) {
    if ((x.type === '|' || x.type === '&') && p && /^(union_type|intersection_type)$/.test(p.type) && p.firstChild?.id === x.id) return true;
    if ((x.type === ';' || x.type === ',') && p && /^(object_type|interface_body|class_body)$/.test(p.type)) return true;
    return false;
  }
  if (x.type === 'parenthesized_expression' && x.namedChildCount === 1 && /^jsx_/.test(x.namedChild(0)?.type ?? '')) return true;
  // `| 'a' | 'b'`: the leading bar wraps the first member in a union of its own.
  if (/^(union_type|intersection_type)$/.test(x.type) && x.namedChildCount === 1 && /^[|&]$/.test(x.firstChild?.type ?? '')) return true;
  if (x.type === 'formal_parameters' && p?.type === 'arrow_function' && x.namedChildCount === 1) {
    const only = x.namedChild(0);
    if (only?.type === 'required_parameter' && only.namedChildCount === 1 && only.namedChild(0)?.type === 'identifier') return true;
  }
  if (x.type === 'required_parameter' && p?.type === 'formal_parameters' && p.parent?.type === 'arrow_function' && p.namedChildCount === 1 && x.namedChildCount === 1 && x.namedChild(0)?.type === 'identifier') return true;
  return false;
}

/**
 * A comma right before a closing bracket changes nothing (formatters add one when
 * they wrap a list vertically). A Python one-element tuple `(a,)` still differs
 * from `(a)`: it parses as a different node.
 */
const SAME_QUOTES = new Set(['typescript', 'tsx', 'python']);

function withoutTrailingCommas(seq: string[]): string[] {
  return seq.filter((t, i) => {
    if (t !== ',') return true;
    let j = i + 1;
    while (seq[j] === '\u0003') j++;
    return !(seq[j] === ')' || seq[j] === ']' || seq[j] === '}' || seq[j] === '>');
  });
}

function collect(root: Node, cfg: LanguageConfig): Entity[] {
  const out: Entity[] = [];
  const visit = (container: Node, parent: string) => {
    const seen = new Map<string, number>();
    for (const decl of cfg.declarationsIn(container)) {
      // Getters/setters share a name; so can overloads. Number repeats so keys stay unique.
      const accessor = decl.node.children.find((c) => c?.type === 'get' || c?.type === 'set')?.type ?? '';
      const base = `${parent}/${decl.kind}:${accessor}${decl.name}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const key = n ? `${base}#${n}` : base;
      out.push({ decl, key, base: `${decl.kind}:${accessor}${decl.name}`, parent, text: decl.node.text, ...leaves(decl.node, cfg) });
      if (decl.members) visit(decl.members, key);
    }
  };
  visit(root, '');
  return out;
}

/**
 * If `a` becomes `b` by consistently swapping identifiers (each old name maps to
 * exactly one new name), return that mapping; otherwise null.
 */
function identifierSubstitution(a: Entity, b: Entity): Map<string, string> | null {
  if (a.tokens.length !== b.tokens.length) return null;
  const ids = new Set(a.identifiers.map((n) => n.text));
  const map = new Map<string, string>();
  for (let i = 0; i < a.tokens.length; i++) {
    const x = a.tokens[i]!;
    const y = b.tokens[i]!;
    if (x === y) continue;
    if (!ids.has(x)) return null;
    const prev = map.get(x);
    if (prev !== undefined && prev !== y) return null;
    map.set(x, y);
  }
  return map;
}

/** The statements inside a declaration that hold no block of their own, in order, plus its first line. */
function simpleStatements(decl: Node, cfg: LanguageConfig): Entity[] {
  const out: Node[] = [];
  const isBlock = (n: Node) => /block|body|suite/.test(n.type);
  const walk = (n: Node): boolean => {
    // Returns whether `n` holds a block; statements of a block that hold none are collected.
    let holds = false;
    for (const c of n.namedChildren) {
      if (!c) continue;
      const inner = walk(c);
      if (isBlock(n) && !inner && !isBlock(c) && !isComment(c)) out.push(c);
      holds ||= inner || isBlock(c);
    }
    return holds;
  };
  walk(decl);
  out.sort((x, y) => x.startIndex - y.startIndex);
  return out.map((c) => ({ ...leaves(c, cfg), decl: { node: c, kind: 'statement', name: '' } }) as unknown as Entity);
}

/** Whole lines of a declaration, from the start of its first line to the start of the line after it. */
const lineRange = (n: Node): SemanticDiffTextRange => range({ line: startLine(n), character: 0 }, { line: endLine(n) + 1, character: 0 });

/** Lines that differ between two texts once their common first and last lines are set aside (1-based, relative). */
function changedLines(a: string, b: string) {
  const la = a.split('\n');
  const lb = b.split('\n');
  let head = 0;
  while (head < la.length && head < lb.length && la[head] === lb[head]) head++;
  let tail = 0;
  while (tail < la.length - head && tail < lb.length - head && la[la.length - 1 - tail] === lb[lb.length - 1 - tail]) tail++;
  return { old: { start: head + 1, end: la.length - tail }, new: { start: head + 1, end: lb.length - tail } };
}

export function detectStructure(oldRoot: Node, newRoot: Node, cfg: LanguageConfig): StructureResult {
  const olds = collect(oldRoot, cfg);
  const news = collect(newRoot, cfg);
  const pairs: Array<[Entity, Entity]> = [];
  const usedOld = new Set<Entity>();
  const usedNew = new Set<Entity>();

  // Pair level by level: top-level declarations, then the members of each paired
  // class, so members pair only with members of the matching class.
  const byParentKey = (list: Entity[]) => {
    const m = new Map<string, Entity[]>();
    for (const e of list) m.set(e.parent, [...(m.get(e.parent) ?? []), e]);
    return m;
  };
  const oldKids = byParentKey(olds);
  const newKids = byParentKey(news);
  const pairLevel = (oldParent: string, newParent: string) => {
    for (const [a, b] of pairSameNamed(oldKids.get(oldParent) ?? [], newKids.get(newParent) ?? [], (e) => e.base, (e) => [...(attachedAbove(e.decl.node, cfg.attachedTypes).match(/\S+/g) ?? []), ...e.tokens])) {
      pairs.push([a, b]);
      usedOld.add(a);
      usedNew.add(b);
      if (a.decl.members && b.decl.members) pairLevel(a.key, b.key);
    }
  };
  pairLevel('', '');
  // Renamed declarations: same container and kind, identical apart from consistently swapped names.
  for (const a of olds) {
    if (usedOld.has(a)) continue;
    for (const b of news) {
      if (usedNew.has(b) || b.parent !== a.parent || b.decl.kind !== a.decl.kind) continue;
      const sub = identifierSubstitution(a, b);
      // The declared name changes, plus at most one other name: more than that is a different declaration.
      // A short declaration (`type Path string`) has too little else to go on: only its name may change.
      const limit = a.tokens.length >= 12 ? 2 : 1;
      // The other name must be the declaration's own (a parameter or local renamed along);
      // `getWidth` -> `getHeight` reading `r.width` -> `r.height` is a different function.
      const own = (x: string) => a.identifiers.some((id) => id.text === x && isDeclarationName(id));
      const declared = a.decl.name.split('.').at(-1)!;
      if (sub && sub.get(declared) !== undefined && sub.size <= limit && [...sub.keys()].every((x) => x === declared || own(x))) {
        pairs.push([a, b]);
        usedOld.add(a);
        usedNew.add(b);
        break;
      }
    }
  }

  const operations: SemanticDiffOperation[] = [];
  const folds: SemanticDiffFold[] = [];

  // Moves: within each container, keep the longest run that stayed in order.
  const moved = new Set<Entity>();
  const byParent = new Map<string, Array<[Entity, Entity]>>();
  for (const p of pairs) if (p[0].parent === p[1].parent) byParent.set(p[0].parent, [...(byParent.get(p[0].parent) ?? []), p]);
  for (const group of byParent.values()) {
    const ordered = [...group].sort((p, q) => p[0].decl.node.startIndex - q[0].decl.node.startIndex);
    const starts = ordered.map((p) => p[1].decl.node.startIndex);
    const keep = longestInOrder(starts, keepWeights(starts, ordered.map((p) => endLine(p[0].decl.node) - startLine(p[0].decl.node) + 1)));
    ordered.forEach(([a, b], i) => {
      if (keep.has(i)) return;
      moved.add(a);
      const na = a.decl.node;
      const nb = b.decl.node;
      // The doc comment directly above a declaration moves with it.
      const da = docStart(na, cfg);
      const db = docStart(nb, cfg);
      const same = a.seq === b.seq && docText(na, da, cfg) === docText(nb, db, cfg);
      const pair: SemanticDiffLinePair = { old: { start: da, end: endLine(na) }, new: { start: db, end: endLine(nb) } };
      const index = operations.push({
        type: same ? 'moved' : 'movedWithEdit',
        spans: [
          {
            role: 'root',
            relation: 'moved',
            old: [range({ line: da, character: 0 }, lineRange(na).end)],
            new: [range({ line: db, character: 0 }, lineRange(nb).end)],
            linePairs: [pair],
          },
        ],
        lines: { old: [{ ...pair.old, spanIndex: 0 }], new: [{ ...pair.new, spanIndex: 0 }] },
      }) - 1;
      if (same) {
        const n = pair.old.end - pair.old.start + 1;
        folds.push({ old: pair.old, operations: [index], counts: { moved: n, edited: 0, removed: 0 } });
      }
    });
  }

  // Renames: merge every consistent substitution; keep names that never conflict.
  const renames = new Map<string, string>();
  const conflicted = new Set<string>();
  // Top-level statements that declare nothing (`test('...', () => { ... })`, `app.get(...)`)
  // hold code too: pair them in order, when alike, as a source of renames only.
  const loose = (root: Node, list: Entity[]) => {
    const declared = new Set(list.map((e) => e.decl.node.startIndex));
    return root.namedChildren
      .filter((c): c is Node => !!c && !isComment(c) && !declared.has(c.startIndex))
      .map((c) => ({ ...leaves(c, cfg), decl: { node: c, kind: 'statement', name: '' } }) as unknown as Entity);
  };
  const looseOld = loose(oldRoot, olds);
  const looseNew = loose(newRoot, news);
  const loosePairs: Array<[Entity, Entity]> = [];
  let from = 0;
  for (const a of looseOld) {
    for (let j = from; j < Math.min(looseNew.length, from + 5); j++) {
      const b = looseNew[j]!;
      if (b.tokens.length === a.tokens.length && identifierSubstitution(a, b)) {
        loosePairs.push([a, b]);
        from = j + 1;
        break;
      }
    }
  }
  // A paired declaration that was also edited (`rate` -> `taxRate` in a function whose discount
  // changed too) does not read the same as a whole, but its statements still can: pair them in
  // order, when alike, as a source of renames only. Which lines a rename may own is decided
  // below, line by line; a line that changed in any other way stays an edit.
  const innerPairs: Array<[Entity, Entity]> = [];
  if (rule('INNER_RENAMES')) {
    for (const [a, b] of pairs) {
      if (a.decl.members || a.seq === b.seq || identifierSubstitution(a, b)) continue;
      const sa = simpleStatements(a.decl.node, cfg);
      const sb = simpleStatements(b.decl.node, cfg);
      let at = 0;
      for (const x of sa) {
        for (let j = at; j < Math.min(sb.length, at + 5); j++) {
          const y = sb[j]!;
          if (y.tokens.length === x.tokens.length && identifierSubstitution(x, y)) {
            innerPairs.push([x, y]);
            at = j + 1;
            break;
          }
        }
      }
    }
  }
  // Names whose only evidence is a statement inside an edited declaration.
  const innerOnly = new Set<string>();
  const inner = new Set(innerPairs);
  for (const pair of [...pairs, ...loosePairs, ...innerPairs]) {
    const [a, b] = pair;
    // Classes and interfaces are judged through their members, which are paired on their own.
    if (a.decl.members) continue;
    const sub = identifierSubstitution(a, b);
    if (!sub) continue;
    for (const [x, y] of sub) {
      if (inner.has(pair)) {
        // Never against what whole declarations say, and new names only.
        if (renames.has(x)) continue;
        innerOnly.add(x);
      }
      if (renames.has(x) && renames.get(x) !== y) conflicted.add(x);
      renames.set(x, y);
    }
  }
  const oldIndex = renames.size ? identifierIndex(oldRoot, cfg) : new Map<string, Node[]>();
  const newIndex = renames.size ? identifierIndex(newRoot, cfg) : new Map<string, Node[]>();
  // Each use must stay inside the same declaration: a use in a deleted function
  // and one in an unrelated new function only look alike by position.
  const partner = new Map<Entity, Entity>(pairs);
  const innermost = (list: Entity[], n: Node) => {
    let best: Entity | null = null;
    for (const e of list) {
      const d = e.decl.node;
      if (d.startIndex <= n.startIndex && n.endIndex <= d.endIndex && (!best || d.startIndex >= best.decl.node.startIndex)) best = e;
    }
    return best;
  };
  const accepted = new Map<string, { oldIds: Node[]; newIds: Node[] }>();
  for (const [from, to] of renames) {
    if (conflicted.has(from)) continue;
    // A renamed name is gone afterwards and its new name was not there before.
    // Otherwise names only shifted against each other (one item deleted from
    // a list and another added further down pairs every name in between).
    // A variable and a property spelled the same are different things: renaming a
    // local `name` does not rename `user.name`. Only uses of the declared kind count.
    const declKinds = new Set((oldIndex.get(from) ?? []).filter(isDeclarationName).map(kindOf));
    const sameKind = (ids: Node[] | undefined) => (ids ?? []).filter((n) => declKinds.has(kindOf(n)));
    if (sameKind(newIndex.get(from)).length || sameKind(oldIndex.get(to)).length) continue;
    // A field's uses are those reached through its own type (`this.value`, `opts.headers`
    // with `opts: RequestOptions`), not the same-named property of another object
    // (`input.value`, `document.title`, a `{ headers }` key passed to fetch).
    const ownUses = (ids: Node[], index: Map<string, Node[]>) => {
      const decl = ids.find(isDeclarationName);
      const owner = decl ? ownerTypeName(decl) : null;
      return owner === null ? ids : ids.filter((n) => isDeclarationName(n) || reachedThrough(n, owner, index));
    };
    const oldIds = ownUses(sameKind(oldIndex.get(from)), oldIndex);
    const newIds = ownUses(sameKind(newIndex.get(to)), newIndex);
    // Every occurrence must have a counterpart, or this is not a clean rename.
    if (!oldIds.length || oldIds.length !== newIds.length) continue;
    // A name used once (`Once` -> `OnceExit`) is a different thing, not a rename.
    if (oldIds.length < 2) continue;
    // A rename changes a name declared in this file; swapping one property access
    // (`user.email` -> `user.mail`) is an edit, not a rename.
    if (!oldIds.some(isDeclarationName)) continue;
    // A field or parameter that also changed type was replaced, not renamed
    // (`toPath func(string) Path` -> `caseSensitivity CaseSensitivity`).
    if (oldIds.some((o, i) => isDeclarationName(o) && declaredTypeChanged(o, newIds[i]!, from, to))) continue;
    // A declaration renamed and also edited is not paired, but is still this rename's own declaration.
    const counterpartOf = (e: Entity) =>
      partner.get(e) ?? (e.decl.name.split('.').at(-1) === from ? news.find((x) => x.parent === e.parent && x.decl.kind === e.decl.kind && x.decl.name === e.decl.name.replace(new RegExp(`${from}$`), to)) : undefined);
    if (oldIds.some((o, i) => { const e = innermost(olds, o); const f = innermost(news, newIds[i]!); return e ? counterpartOf(e) !== f : f !== null; })) continue;
    accepted.set(from, { oldIds, newIds });
  }
  // A name found only inside an edited declaration is a rename when the thing named is plainly the
  // same: a variable or parameter whose own declaration reads the same apart from renames. A new
  // name bound to something else (`typeChecker` -> `typeCheckerUtils`, another service; `entityTasks`
  // -> `openTasks`, now a count) is a replacement; so is a function whose body also changed.
  const declarationOf = (id: Node) => {
    let p = id.parent!;
    while (p.parent && /pattern$|_list$/.test(p.type)) p = p.parent;
    return p;
  };
  // Only a rename's own uses may differ: `logDirs = config.logDirs()` -> `absoluteLogDirs =
  // config.absoluteLogDirs()` also calls another method, spelled like the variable.
  const sameDeclaration = (o: Node, n: Node) => {
    const d = declarationOf(o);
    const a = leaves(d, cfg).tokens;
    const b = leaves(declarationOf(n), cfg).tokens;
    if (a.length !== b.length) return false;
    const swapped = new Map<string, number>();
    for (let i = 0; i < a.length; i++) {
      const t = a[i]!;
      if (t === b[i]) continue;
      if (!accepted.has(t) || renames.get(t) !== b[i]) return false;
      // A name after a dot is another object's member, whatever the grammar calls it.
      if (i > 0 && /^(\.|->|::|\?\.)$/.test(a[i - 1]!)) return false;
      swapped.set(t, (swapped.get(t) ?? 0) + 1);
    }
    for (const [t, count] of swapped) {
      const own = accepted.get(t)!.oldIds.filter((id) => d.startIndex <= id.startIndex && id.endIndex <= d.endIndex).length;
      if (own !== count) return false;
    }
    return true;
  };
  const NOT_A_VARIABLE = /function|method|class|interface|struct|enum|trait|constructor|type_alias|impl/;
  // Until nothing more is dropped: a declaration may lean on another rename that is dropped later.
  for (let dropped = true; dropped; ) {
    dropped = false;
    for (const [from, { oldIds, newIds }] of [...accepted]) {
      if (!innerOnly.has(from)) continue;
      if (oldIds.some((o, i) => isDeclarationName(o) && (NOT_A_VARIABLE.test(o.parent!.type) || !sameDeclaration(o, newIds[i]!)))) {
        accepted.delete(from);
        dropped = true;
      }
    }
  }
  // A line belongs to a rename only when renaming is its only change; a line
  // that also changed behaviour (`n < LIMIT` -> `n <= MAX`) stays a plain edit.
  // A shorthand key (`{ timeout }` -> `{ delay }`) also renames an object key.
  const oldText = oldRoot.text.split('\n');
  const newText = newRoot.text.split('\n');
  const words = (l: string) => l.match(/[\p{L}\p{N}_$]+|\S/gu) ?? [];
  // The check swaps exactly the rename's own uses on the line, not every word spelled the same.
  const usesOnLine = new Map<number, Array<{ col: number; len: number; to: string }>>();
  for (const [from, { oldIds }] of accepted) {
    for (const o of oldIds) {
      if (o.startPosition.row !== o.endPosition.row) continue;
      const l = startLine(o);
      usesOnLine.set(l, [...(usesOnLine.get(l) ?? []), { col: o.startPosition.column, len: o.endPosition.column - o.startPosition.column, to: renames.get(from)! }]);
    }
  }
  const swapped = (l: number) => {
    let line = oldText[l - 1] ?? '';
    for (const u of [...(usesOnLine.get(l) ?? [])].sort((x, y) => y.col - x.col)) line = line.slice(0, u.col) + u.to + line.slice(u.col + u.len);
    return line;
  };
  const clean = (o: Node, n: Node) => !SHORTHAND.has(o.type) && words(swapped(startLine(o))).join(' ') === words(newText[startLine(n) - 1] ?? '').join(' ');
  // An import alias stands for what it imports: when the import itself changed
  // (`debounce as d` -> `throttle as t`), its uses call something else.
  for (const [from, { oldIds, newIds }] of [...accepted]) {
    if (oldIds.some((o, i) => /import|use_/.test(o.parent?.type ?? '') && isDeclarationName(o) && !clean(o, newIds[i]!))) accepted.delete(from);
  }
  // Renames that share a line are one operation, one span per name, so none of them loses its lines to another.
  const group = new Map<string, string>();
  const root = (k: string): string => (group.get(k) === k ? k : root(group.get(k)!));
  const lineOwner = new Map<number, string>();
  const kept = new Map<string, Array<[Node, Node]>>();
  for (const [from, { oldIds, newIds }] of accepted) {
    const occ = oldIds.map((o, i) => [o, newIds[i]!] as [Node, Node]).filter(([o, n]) => clean(o, n));
    if (!occ.length) continue;
    kept.set(from, occ);
    group.set(from, from);
    for (const [o] of occ) {
      const other = lineOwner.get(startLine(o));
      if (other) group.set(root(from), root(other));
      else lineOwner.set(startLine(o), from);
    }
  }
  const groups = new Map<string, string[]>();
  for (const k of kept.keys()) groups.set(root(k), [...(groups.get(root(k)) ?? []), k]);
  for (const names of groups.values()) {
    const spans: SemanticDiffOperation['spans'] = [];
    const lines = { old: [] as Array<{ start: number; end: number; spanIndex: number }>, new: [] as Array<{ start: number; end: number; spanIndex: number }> };
    const seen = new Set<string>();
    for (const from of names) {
      const occ = kept.get(from)!;
      const linePairs: SemanticDiffLinePair[] = [];
      for (const [o, n] of occ) {
        const k = `${startLine(o)}:${startLine(n)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        linePairs.push({ old: { start: startLine(o), end: startLine(o) }, new: { start: startLine(n), end: startLine(n) } });
      }
      const spanIndex = spans.push({ role: 'focus', relation: 'replaced', old: occ.map(([o]) => rangeOf(o)), new: occ.map(([, n]) => rangeOf(n)), linePairs }) - 1;
      for (const p of linePairs) {
        lines.old.push({ ...p.old, spanIndex });
        lines.new.push({ ...p.new, spanIndex });
      }
    }
    lines.old.sort((x, y) => x.start - y.start);
    lines.new.sort((x, y) => x.start - y.start);
    operations.push({ type: 'renamed', spans, lines });
  }

  // Formatting only: same tokens, same comments, different text.
  // A class or interface whose whole shape is unchanged (`interface P { a: string }` wrapped
  // onto lines) is reformatted as a whole; otherwise its changed members are reported.
  const whole = pairs.filter(([a, b]) => a.decl.members && !moved.has(a) && a.text !== b.text && a.seq === b.seq && !a.decl.node.hasError && !b.decl.node.hasError && invisibles(a.text) === invisibles(b.text)).map(([a]) => a.decl.node);
  const insideWhole = (a: Entity) => whole.some((w) => w.id !== a.decl.node.id && w.startIndex <= a.decl.node.startIndex && a.decl.node.endIndex <= w.endIndex);
  for (const [a, b] of pairs) {
    if (moved.has(a) || a.text === b.text || insideWhole(a)) continue;
    // A comment that changed places changes what it describes: not formatting.
    if (a.seq !== b.seq) continue;
    // Invisible characters (zero-width space, line separators) can change how code
    // parses or reads, so a change involving them is never called formatting.
    if (invisibles(a.text) !== invisibles(b.text)) continue;
    // Code that does not parse has no reliable shape to compare.
    if (a.decl.node.hasError || b.decl.node.hasError) continue;
    // Rust macro arguments are raw tokens: spacing can be the macro's input (`stringify!`).
    if (macroArgs(a.decl.node) !== macroArgs(b.decl.node)) continue;
    if (a.decl.members && !whole.includes(a.decl.node)) continue; // report the changed members, not the whole class
    const rel = changedLines(a.text, b.text);
    // Formatting changes lines on both sides; a declaration that only grew or shrank
    // at its edge (a `;` attached from the next line) did not get reformatted.
    if (rel.old.start > rel.old.end || rel.new.start > rel.new.end) continue;
    const oldStart = startLine(a.decl.node) + rel.old.start - 1;
    const newStart = startLine(b.decl.node) + rel.new.start - 1;
    const pair: SemanticDiffLinePair = {
      old: { start: oldStart, end: startLine(a.decl.node) + rel.old.end - 1 },
      new: { start: newStart, end: startLine(b.decl.node) + rel.new.end - 1 },
    };
    operations.push({
      type: 'reformatted',
      spans: [
        {
          role: 'root',
          relation: 'mapped',
          old: [range({ line: pair.old.start, character: 0 }, { line: pair.old.end + 1, character: 0 })],
          new: [range({ line: pair.new.start, character: 0 }, { line: pair.new.end + 1, character: 0 })],
          linePairs: [pair],
        },
      ],
      lines: { old: [{ ...pair.old, spanIndex: 0 }], new: [{ ...pair.new, spanIndex: 0 }] },
    });
  }

  const paired = pairs.map(([a]) => ({ start: docStart(a.decl.node, cfg), end: endLine(a.decl.node) }));
  return { operations, folds, paired };
}

const invisibles = (t: string) => (t.match(/[\u200b-\u200f\u2028\u2029\u2060\ufeff\u00ad]/g) ?? []).join('');

const macroArgs = (n: Node) => n.descendantsOfType('token_tree').map((t) => t?.text ?? '').join('\u0000');

/** The class, interface or type a field is declared in (null for anything else). */
function ownerTypeName(decl: Node): string | null {
  if (kindOf(decl) !== 'member') return null;
  for (let p = decl.parent; p; p = p.parent) {
    if (/^(class_declaration|abstract_class_declaration|interface_declaration|type_alias_declaration|class|struct_item|type_spec|class_definition)$/.test(p.type)) return p.childForFieldName('name')?.text ?? null;
    if (/^(object|statement_block|program|source_file|module)$/.test(p.type)) return null;
  }
  return null;
}

/** Whether a use of a field declared in `owner` is reached through that type. */
function reachedThrough(n: Node, owner: string, index: Map<string, Node[]>): boolean {
  const p = n.parent;
  if (!p) return true;
  // An object-literal key belongs to whatever type the literal has, which is unknown.
  if (p.type === 'pair' && p.childForFieldName('key')?.id === n.id) return false;
  if (kindOf(n) !== 'member' || p.namedChildren.at(-1)?.id !== n.id) return true;
  const obj = p.childForFieldName('object') ?? p.childForFieldName('operand') ?? p.childForFieldName('value') ?? p.namedChild(0);
  if (!obj || obj.type === 'this' || /^(this|self|base|super)$/.test(obj.text)) return true;
  if (obj.type !== 'identifier') return true; // a longer chain: unknown
  const decls = (index.get(obj.text) ?? []).filter(isDeclarationName);
  if (!decls.length) return false; // a global (`document`, `window`): not this type
  return decls.some((d) => {
    const t = d.parent?.childForFieldName('type');
    return !t || new RegExp(`\\b${owner}\\b`).test(t.text);
  });
}

/** What a name refers to: a variable or function (`binding`), a property or field reached through an object (`member`), or a type. */
function kindOf(n: Node): 'binding' | 'member' | 'type' {
  if (n.type === 'type_identifier') return 'type';
  if (SHORTHAND.has(n.type)) return 'binding';
  const p = n.parent;
  // `user.name`, `self.name`, `x.Name`, `obj->name`: the name after the dot.
  if (p && /^(member_expression|attribute|field_expression|selector_expression|field_access|member_access_expression)$/.test(p.type) && p.namedChildren.length > 1 && p.namedChildren.at(-1)?.id === n.id) return 'member';
  if (/property_identifier|field_identifier/.test(n.type)) return 'member';
  return 'binding';
}

/** Identifiers that are both a variable and an object key. */
const SHORTHAND = new Set(['shorthand_property_identifier', 'shorthand_property_identifier_pattern', 'shorthand_field_identifier']);

/** The identifier is the name being declared (a variable, parameter, function, field, type...). */
const DECLARING_PARENT = /(declaration|declarator|definition|parameter|specifier|signature|_spec|_clause|_item|_variant|enum_assignment)$/;

/** The declared type next to a name, compared with this rename applied (a type can be the thing renamed). */
function declaredTypeChanged(o: Node, n: Node, from: string, to: string): boolean {
  const ta = o.parent?.childForFieldName('type');
  const tb = n.parent?.childForFieldName('type');
  if (!ta && !tb) return false;
  if (!ta || !tb) return true;
  const swap = (t: string) => t.replace(/\w+/g, (w) => (w === from ? to : w)).replace(/\s+/g, '');
  return swap(ta.text) !== tb.text.replace(/\s+/g, '');
}

function isDeclarationName(id: Node): boolean {
  const p = id.parent;
  // Only declaring constructs: a qualified reference such as `Anthropic.X` or
  // `user.email` also has a `name` field, but declares nothing.
  if (!p) return false;
  // Python: plain parameters sit directly in the list; `x = ...` declares x.
  if (p.type === 'parameters' || p.type === 'lambda_parameters') return true;
  if (p.type === 'typed_parameter') return p.namedChild(0)?.startIndex === id.startIndex;
  if (p.type === 'assignment') return p.childForFieldName('left')?.startIndex === id.startIndex;
  // Go: `x := ...` and `for k, v := range` declare through their left-hand list.
  if (p.type === 'expression_list' && (p.parent?.type === 'short_var_declaration' || p.parent?.type === 'range_clause')) return p.parent.childForFieldName('left')?.startIndex === p.startIndex;
  // Names bound by patterns (`Some(byte) =>`, `let (a, b)`, `[x, y] = ...`) and
  // closure parameters (`|a, b|`). In `{ key: value }` patterns only the value is bound.
  if (/pattern$/.test(p.type) || p.type === 'closure_parameters') {
    const bound = p.childForFieldName('value') ?? p.childForFieldName('pattern');
    return !bound || bound.startIndex === id.startIndex;
  }
  // Java lambda parameters without types (`(key, value) -> ...`) and Python's
  // `except E as exc` / `with f() as x` targets.
  if (p.type === 'inferred_parameters' || p.type === 'as_pattern_target') return true;
  // TypeScript enum members without a value: `enum E { A, B }`.
  if (p.type === 'enum_body') return true;
  if (!DECLARING_PARENT.test(p.type)) return false;
  // `import { A }` -> `import { B }` brings in a different thing; only a local
  // alias (`import { A as b }`) is a name this file owns.
  if (p.type === 'import_specifier') {
    const alias = p.childForFieldName('alias');
    return !!alias && alias.startIndex === id.startIndex;
  }
  // Every name, not just the first: Go declares several at once (`dirs, names []string`).
  for (const field of ['name', 'pattern']) {
    for (const n of p.childrenForFieldName(field)) if (n && n.startIndex === id.startIndex && n.endIndex === id.endIndex) return true;
  }
  return false;
}

/** First line of the comments directly above a declaration (no blank line between), else its own first line. */
function docStart(n: Node, cfg: LanguageConfig): number {
  let line = startLine(n);
  // Rust line comments end at the start of the next line, so compare start lines.
  for (let c = n.previousSibling; c && cfg.attachedTypes.has(c.type) && commentEnd(c) === line - 1; c = c.previousSibling) line = startLine(c);
  return line;
}

/** Last line a node really covers (a node ending in a newline ends on the line before). */
const commentEnd = (c: Node) => (c.endPosition.column === 0 && c.endPosition.row > c.startPosition.row ? c.endPosition.row : c.endPosition.row + 1);

function docText(n: Node, from: number, cfg: LanguageConfig): string {
  const out: string[] = [];
  for (let c = n.previousSibling; c && cfg.attachedTypes.has(c.type) && startLine(c) >= from; c = c.previousSibling) out.push(c.text.trim());
  return out.join('\n');
}

/** Every identifier in the tree, by name. */
function identifierIndex(root: Node, cfg: LanguageConfig): Map<string, Node[]> {
  const out = new Map<string, Node[]>();
  const stack: Node[] = [root];
  while (stack.length) {
    const x = stack.pop()!;
    if (x.childCount === 0) {
      if (cfg.identifierTypes.has(x.type)) {
        const list = out.get(x.text);
        if (list) list.push(x);
        else out.set(x.text, [x]);
      }
      continue;
    }
    for (let i = x.childCount - 1; i >= 0; i--) {
      const c = x.child(i);
      if (c) stack.push(c);
    }
  }
  // Source order, as the recursive walk gave.
  for (const list of out.values()) list.sort((a, b) => a.startIndex - b.startIndex);
  return out;
}
