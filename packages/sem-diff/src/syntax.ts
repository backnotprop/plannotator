// Small helpers over tree-sitter nodes: positions, tokens, similarity, and
// finding functions, statements and calls with a language config.
import { rule } from './runtime.ts';
import type { Node } from 'web-tree-sitter';
import { isComment, type LanguageConfig } from './parse.ts';
import type { SemanticDiffTextPosition, SemanticDiffTextRange } from './pierre-types.ts';

export const pos = (p: { row: number; column: number }): SemanticDiffTextPosition => ({
  line: p.row + 1,
  character: p.column,
});

export const rangeOf = (n: Node): SemanticDiffTextRange => ({ start: pos(n.startPosition), end: pos(n.endPosition) });

export const range = (start: SemanticDiffTextPosition, end: SemanticDiffTextPosition): SemanticDiffTextRange => ({
  start,
  end,
});

export const startLine = (n: Node) => n.startPosition.row + 1;
export const endLine = (n: Node) => n.endPosition.row + 1;

/** Leaf tokens of a node, comments excluded. Whitespace never appears in tokens. */
export function tokens(n: Node): string[] {
  const out: string[] = [];
  // Iterative: very deep trees would overflow the stack.
  const stack: Node[] = [n];
  while (stack.length) {
    const x = stack.pop()!;
    if (isComment(x)) continue;
    if (x.childCount === 0) {
      if (x.text.length) out.push(x.text);
      continue;
    }
    for (let i = x.childCount - 1; i >= 0; i--) {
      const c = x.child(i);
      if (c) stack.push(c);
    }
  }
  return out;
}

/** Dice similarity of two token multisets: 1 = same tokens, 0 = nothing shared. */
export function dice(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const c = counts.get(t);
    if (c) {
      shared++;
      counts.set(t, c - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

export interface FunctionInfo {
  name: string;
  /** Unique within the file: enclosing class or receiver type, name, and `#n` for repeats. */
  key: string;
  node: Node;
  body: Node;
  statements: Node[];
}

/**
 * The name an object literal is held under: `const actionWrap = register({ perform() {} })`
 * makes its functions `actionWrap.perform`, so several objects' `perform`s stay apart.
 */
function holderOf(obj: Node): string | undefined {
  for (let p = obj.parent, depth = 0; p && depth < 6; p = p.parent, depth++) {
    if (p.type === 'variable_declarator' || p.type === 'public_field_definition') return p.childForFieldName('name')?.text;
    if (p.type === 'pair') return p.childForFieldName('key')?.text;
    if (p.type === 'assignment_expression') return p.childForFieldName('left')?.text;
    if (!/^(arguments|call_expression|parenthesized_expression|as_expression|satisfies_expression|export_statement)$/.test(p.type)) return undefined;
  }
  return undefined;
}

/** The class, interface or object a function belongs to (TS), or its receiver type (Go). */
function scopeOf(n: Node): string {
  const recv = n.childForFieldName('receiver');
  if (recv) return (recv.text.match(/\*?\s*([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*\)\s*$/) ?? [])[1] ?? '';
  const names: string[] = [];
  for (let p = n.parent; p; p = p.parent) {
    if (/class|interface|object|function|method|trait|impl|mod_item/.test(p.type)) {
      // A Rust `impl` is named by its type: methods of `impl Foo` belong to Foo.
      const name = p.type === 'impl_item' ? p.childForFieldName('type')?.text.replace(/<.*$/s, '') : p.type === 'object' ? holderOf(p) : p.childForFieldName('name')?.text;
      if (name) names.unshift(name);
    }
  }
  return names.join('.');
}

export function functionsIn(root: Node, cfg: LanguageConfig): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  const seen = new Map<string, number>();
  const walk = (n: Node) => {
    if (cfg.functionTypes.has(n.type)) {
      const name = cfg.nameOf(n);
      const body = cfg.bodyOf(n);
      if (name && body) {
        const base = `${scopeOf(n)}/${name}`;
        const k = seen.get(base) ?? 0;
        seen.set(base, k + 1);
        out.push({ name, key: k ? `${base}#${k}` : base, node: n, body, statements: cfg.statementsOf(body) });
      }
    }
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(root);
  return out;
}

/** Every statement at any depth inside `n` (statements of nested blocks included). */
export function allStatements(n: Node, cfg: LanguageConfig): Node[] {
  const out: Node[] = [];
  const walk = (x: Node) => {
    if (cfg.blockTypes.has(x.type)) out.push(...cfg.statementsOf(x));
    for (const c of x.namedChildren) if (c) walk(c);
  };
  walk(n);
  return out;
}

/**
 * Calls to `name` inside `n`. With `fn`, a call passing more arguments than the
 * function takes is a different function of the same name (`caseSensitivity.PathKey(p)`
 * is not `(t *parseTask) PathKey()`).
 */

export function callsTo(n: Node, name: string, cfg: LanguageConfig, fn?: Node): Node[] {
  const max = fn ? maxArguments(fn) : Infinity;
  const min = fn && rule('ARITY_MIN') && cfg.id === 'java' ? requiredArguments(fn) : 0;
  const out: Node[] = [];
  const walk = (x: Node) => {
    // A free function is never called through an object: `JSON.parse(t)` does not call a local `parse`.
    if (x.type === cfg.callType && cfg.calleeOf(x) === name && argumentCount(x) <= max && argumentCount(x) >= min && !(fn && !isMethod(fn) && memberCall(x)) && !(fn?.type === 'pair' && memberCall(x) && !thisCall(x))) out.push(x);
    // JSX renders a component by calling it: `<OrderRow order={o} />` calls `OrderRow`.
    // Effect runs a defined effect with `yield* load` or `yield* load.pipe(...)`: no call, but the same use.
    else if (x.type === 'yield_expression' && x.child(1)?.type === '*' && yieldsEffect(x.namedChild(0), name)) out.push(x);
    else if ((x.type === 'jsx_self_closing_element' || x.type === 'jsx_opening_element') && /^[A-Z]/.test(name) && x.childForFieldName('name')?.text === name) out.push(x.type === 'jsx_opening_element' && x.parent ? x.parent : x);
    // A Java constructor runs another of its class with `this(...)` (only with the right argument count).
    else if (rule('CONSTRUCTOR_CHAINS') && fn?.type === 'constructor_declaration' && x.type === 'explicit_constructor_invocation' && x.childForFieldName('constructor')?.type === 'this' && argumentCount(x) <= max && argumentCount(x) >= min) out.push(x);
    // `new Internals(def)` runs a constructor function.
    else if (rule('VALUE_REFS') && x.type === 'new_expression' && x.childForFieldName('constructor')?.text === name) out.push(x);
    // A function handed over as a value is used all the same: `Effect.catch(failSearch)`,
    // `items.map(toRow)`, `atom(resolveLoad)`. Only bare names in argument lists, and never a
    // function of an object literal (those are reached through `this` only).
    else if (rule('VALUE_REFS') && x.parent?.type === 'arguments' && cfg.identifierTypes.has(x.type) && x.text === name && fn?.type !== 'pair' && x.parent.parent?.type === cfg.callType && cfg.calleeOf(x.parent.parent) !== name) out.push(x);
    for (const c of x.namedChildren) if (c) walk(c);
  };
  walk(n);
  return out;
}

/** All descendants of `n` (including `n`) whose token sequence equals `want`. */
export function nodesWithTokens(n: Node, want: string[]): Node[] {
  const key = want.join('\u0000');
  const out: Node[] = [];
  const walk = (x: Node) => {
    if (tokens(x).join('\u0000') === key) out.push(x);
    for (const c of x.namedChildren) if (c) walk(c);
  };
  walk(n);
  return out;
}

function argumentCount(call: Node): number {
  const args = call.childForFieldName('arguments');
  return args ? args.namedChildren.filter((c) => c !== null && !isComment(c)).length : 0;
}

/**
 * Java has no optional parameters: a call passing fewer arguments than a method takes calls another
 * method of that name (`this.reader.read()` is not `read(boolean readEscaped)`). Varargs may be empty.
 */
function requiredArguments(fn: Node): number {
  const params = fn.childForFieldName('parameters');
  if (!params) return 0;
  let n = 0;
  for (const p of params.namedChildren) {
    if (!p || isComment(p) || p.type === 'receiver_parameter') continue;
    if (p.type === 'spread_parameter') return n;
    n++;
  }
  return n;
}

/** Most arguments a function accepts; Infinity with a rest/variadic parameter. */
function maxArguments(fn: Node): number {
  // Arrow functions and function expressions keep their parameters in the value; `x => ...` has one.
  const value = fn.childForFieldName('value');
  if (value?.childForFieldName('parameter')) return 1;
  const params = fn.childForFieldName('parameters') ?? value?.childForFieldName('parameters');
  if (!params) return Infinity;
  let n = 0;
  for (const p of params.namedChildren) {
    if (!p || isComment(p)) continue;
    // Rest parameters: `...xs` (TS), `xs ...T` (Go), `*args`/`**kw` (Python), `params T[] xs` (C#).
    if (p.text.includes('...') || /^\*|^params\s/.test(p.text) || p.type.includes('splat')) return Infinity;
    // Go groups names that share a type: `a, b int`.
    const names = p.childrenForFieldName?.('name')?.filter(Boolean).length ?? 0;
    n += Math.max(1, names);
  }
  return n;
}

/**
 * Indexes (into `seq`) of the strictly increasing subsequence with the most
 * total `weight`: the declarations that stay in place, so the rest are the moves.
 * Callers weight by size in lines, so the fewest lines are shown as moved (a long
 * import stays and the short ones around it move, as a line diff would have it),
 * with a small bonus for staying at the same position to settle ties (a re-sort
 * that leaves an import where it was does not report it). O(n log n).
 */
export function longestInOrder(seq: number[], weight: number[] = seq.map(() => 1)): Set<number> {
  const n = seq.length;
  // Fenwick tree over the ranks of `seq`, holding the best chain ending below each rank.
  const ranks = [...new Set(seq)].sort((a, b) => a - b);
  const rank = new Map(ranks.map((v, i) => [v, i + 1]));
  const treeBest = new Array<number>(ranks.length + 1).fill(0);
  const treeAt = new Array<number>(ranks.length + 1).fill(-1);
  const best = new Array<number>(n).fill(0);
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const r = rank.get(seq[i]!)!;
    let b = 0;
    let at = -1;
    for (let k = r - 1; k > 0; k -= k & -k) if (treeBest[k]! > b) { b = treeBest[k]!; at = treeAt[k]!; }
    best[i] = b + weight[i]!;
    prev[i] = at;
    for (let k = r; k <= ranks.length; k += k & -k) if (best[i]! > treeBest[k]!) { treeBest[k] = best[i]!; treeAt[k] = i; }
  }
  let end = -1;
  for (let i = 0; i < n; i++) if (end < 0 || best[i]! > best[end]!) end = i;
  const keep = new Set<number>();
  for (let i = end; i >= 0; i = prev[i]!) keep.add(i);
  return keep;
}

/**
 * Weights for `longestInOrder`, for pairs listed in old order: size in lines,
 * plus a tie-breaking bonus for staying at the same position among the pairs.
 */
export function keepWeights(newStarts: number[], lines: number[]): number[] {
  const rank = new Map([...newStarts].sort((a, b) => a - b).map((v, i) => [v, i]));
  // Scaled so that all the bonuses together never outweigh one line.
  const scale = newStarts.length + 1;
  return newStarts.map((v, i) => lines[i]! * scale + (rank.get(v) === i ? 1 : 0));
}

/**
 * Pair items that share a base key (kind + name). A name used once on each side
 * pairs directly; repeated names (overloads, `#[cfg]` twins, Go `init()`, two
 * imports from one module) pair by similarity, not position, so inserting one
 * overload first does not shift every pairing by one.
 */
export function pairSameNamed<T>(olds: T[], news: T[], base: (t: T) => string, toks: (t: T) => string[]): Array<[T, T]> {
  const group = (xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) m.set(base(x), [...(m.get(base(x)) ?? []), x]);
    return m;
  };
  const go = group(olds);
  const gn = group(news);
  const out: Array<[T, T]> = [];
  for (const [k, as] of go) {
    const bs = gn.get(k);
    if (!bs) continue;
    // Huge groups (generated code repeating one name thousands of times) pair in
    // order: comparing every pair would take time and memory in the square of the size.
    if ((as.length === 1 && bs.length === 1) || as.length * bs.length > 2500) {
      for (let i = 0; i < Math.min(as.length, bs.length); i++) out.push([as[i]!, bs[i]!]);
      continue;
    }
    const ta = as.map(toks);
    const tb = bs.map(toks);
    const cand: Array<[number, number, number]> = [];
    as.forEach((_, i) => bs.forEach((_, j) => cand.push([dice(ta[i]!, tb[j]!), i, j])));
    // Most similar first; ties keep their order (the i-th old with the i-th new).
    cand.sort((x, y) => y[0] - x[0] || Math.abs(x[1] - x[2]) - Math.abs(y[1] - y[2]) || x[1] - y[1]);
    const ua = new Set<number>();
    const ub = new Set<number>();
    for (const [sim, i, j] of cand) {
      if (ua.has(i) || ub.has(j)) continue;
      // Leftovers that share little are not the same declaration (one overload became
      // another function; a new one was added): leave them unpaired.
      if (sim < 0.3) continue;
      ua.add(i);
      ub.add(j);
      out.push([as[i]!, bs[j]!]);
    }
  }
  return out;
}

/** The function is a method (of a class, impl, receiver type), so `x.name()` can call it. */
export function isMethod(fn: Node): boolean {
  if (fn.childForFieldName('receiver')) return true;
  for (let p = fn.parent; p; p = p.parent) {
    if (/class|interface|impl_item|trait_item|object|struct_declaration|record_declaration|enum_declaration/.test(p.type)) return true;
    if (/function|method/.test(p.type) && p !== fn) return false;
  }
  return false;
}

/** The call names its function through an object (`a.f()`, `pkg.F()`, `self.f()`), not bare (`f()`). */
/** `load` or `load.pipe(...)`: the effect named `name`, run as is or piped through operators. */
function yieldsEffect(n: Node | null, name: string): boolean {
  if (n?.type === 'identifier') return n.text === name;
  const f = n?.type === 'call_expression' ? n.childForFieldName('function') : null;
  return f?.type === 'member_expression' && f.childForFieldName('property')?.text === 'pipe' && f.childForFieldName('object')?.type === 'identifier' && f.childForFieldName('object')?.text === name;
}

/**
 * `this.f()`: a call on the object itself. A function stored in an object literal
 * (`{ run: () => ... }`) is reached this way from its siblings; `options.run()` elsewhere
 * calls whatever `options` holds, not necessarily this literal's `run`.
 */
function thisCall(call: Node): boolean {
  return call.childForFieldName('function')?.childForFieldName('object')?.type === 'this';
}

function memberCall(call: Node): boolean {
  if (call.childForFieldName('object')) return true; // Java
  const f = call.childForFieldName('function');
  return !!f && /member_expression|selector_expression|field_expression|attribute|member_access_expression/.test(f.type);
}

/** Text of the comments and attributes directly above a declaration (they belong to it). */
export function attachedAbove(n: Node, attached: ReadonlySet<string>): string {
  const out: string[] = [];
  let line = n.startPosition.row;
  for (let c = n.previousSibling; c && attached.has(c.type); c = c.previousSibling) {
    const end = c.endPosition.column === 0 && c.endPosition.row > c.startPosition.row ? c.endPosition.row - 1 : c.endPosition.row;
    if (end !== line - 1) break;
    out.unshift(c.text.trim());
    line = c.startPosition.row;
  }
  return out.join('\n');
}
