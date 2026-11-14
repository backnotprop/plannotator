// Inlined-function detection, producing Pierre `inlinedFunction` operations.
//
// A helper H is inlined into a caller C when:
//   1. H exists in the old file and is gone from the new one,
//   2. old C calls H and new C no longer does,
//   3. H's statements (minus its final return) reappear inside new C, and
//   4. H's return value replaces the call expression.
// Extraction is the same check with the two versions swapped (see extract.ts).
import type { Node } from 'web-tree-sitter';
import { isComment, type LanguageConfig } from './parse.ts';
import { likelyMoved, probabilityMoved, type Evidence } from './classifier.ts';
import { currentSetup, flags, rule, type Candidate } from './runtime.ts';
import { pairFunctions } from './pairing.ts';
import type { SemanticDiffLineRange, SemanticDiffOperation } from './pierre-types.ts';
import {
  allStatements,
  callsTo,
  dice,
  endLine,
  functionsIn,
  nodesWithTokens,
  pos,
  range,
  rangeOf,
  startLine,
  tokens,
  type FunctionInfo,
} from './syntax.ts';

export interface InlineOptions {
  /** Minimum token similarity for a helper statement to count as moved. */
  statementSimilarity: number;
  /** Minimum share of the helper's tokens that must reappear in the caller. */
  coverage: number;
  /** Set by extract detection, which runs this check with the versions swapped. */
  mirrored?: boolean;
  /**
   * Let the learned check (`classifier.ts`) accept candidates the rules reject. Off by default:
   * it added finds on practice projects it had not seen, but none on the held-out sets.
   */
  learned?: boolean;
  /** Per-diff second opinion (takes precedence over `configure({ secondOpinion })`). */
  secondOpinion?: (candidate: Candidate) => boolean;
}

export const DEFAULT_INLINE_OPTIONS: InlineOptions = { statementSimilarity: 0.7, coverage: 0.5 };

const key = (n: Node) => tokens(n).join('\u0000');

/** Names and literals: what a statement is about, without its punctuation and keywords. */
const KEYWORDS = new Set(['if', 'else', 'return', 'throw', 'new', 'const', 'let', 'var', 'await', 'async', 'for', 'while', 'nil', 'null', 'undefined', 'true', 'false', 'err', 'error', 'self', 'this', 'fn', 'func', 'def', 'let', 'mut', 'Ok', 'Err', 'Some', 'None']);
// String literals count three times: in error checks and guard clauses
// (`return fmt.Errorf("open db: %w", err)`) the message is what tells them apart.
function words(n: Node): string[] {
  const out: string[] = [];
  const walk = (x: Node) => {
    if (isComment(x)) return;
    if (/string|template/.test(x.type) && !/content|fragment/.test(x.type)) {
      out.push(x.text, x.text, x.text); // the whole literal: grammars split it into quotes and content
      return;
    }
    if (x.childCount === 0) {
      if (/^[\p{L}\p{N}_$]/u.test(x.text) && !KEYWORDS.has(x.text)) out.push(x.text);
      return;
    }
    for (const c of x.children) if (c) walk(c);
  };
  walk(n);
  return out;
}

/**
 * The statement's shape with string contents masked: error checks and guard clauses
 * (`if err != nil { return fmt.Errorf("...", err) }`, `if (!x) throw new Error('...')`)
 * repeat across a file and cannot show that code moved.
 */
// Text-based and only for short statements: boilerplate is short, and taking every
// nested statement's tokens costs time in proportion to depth.
const shape = (n: Node) =>
  n.endIndex - n.startIndex > 300 ? null : n.text.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '"').replace(/\s+/g, '');
function boilerplate(roots: Node[], cfg: LanguageConfig): Set<string> {
  // Repeated within one version: a moved statement has one copy in each, which is not repetition.
  const out = new Set<string>();
  for (const r of roots) {
    const seen = new Map<string, number>();
    for (const st of allStatements(r, cfg)) {
      const k = shape(st);
      if (k !== null) seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [k, n] of seen) if (n >= 2) out.add(k);
  }
  return out;
}
const why = (helper: string, reason: string) => { if (flags.reasons()) console.error(`[inline] ${helper}: ${reason}`); };

/** `const x = helper(...)` where the helper returns the identifier `x`. */
function assignsToSameName(call: Node, value: Node): boolean {
  if (value.namedChildCount !== 0) return false;
  for (let n = call.parent; n; n = n.parent) {
    const name = n.childForFieldName('name') ?? n.childForFieldName('left');
    if (name) return name.text === value.text;
    if (n.type.endsWith('statement') || n.type.endsWith('declaration')) return false;
  }
  return false;
}

/** Best one-to-one pairing of two statement lists by similarity, greedy and deterministic. */
/** Statements this long (in tokens) rarely look alike by chance. */
const LONG_STATEMENT = 25;

function pairStatements(a: Node[], b: Node[], min: number, common: Set<string> = new Set()): Array<{ a: Node; b: Node; similarity: number }> {
  const ta = a.map(tokens);
  const tb = b.map(tokens);
  const wa = a.map(words);
  const wb = b.map(words);
  const ca = ta.map((t) => new Set(calledNames(t)));
  const cb = tb.map((t) => new Set(calledNames(t)));
  // Code that calls something else does something else: `card.classList.add('hidden')`
  // is not `search.classList.toggle('hidden', !visible)`, however alike their words.
  const sameAction = (i: number, j: number) => !ca[i]!.size || !cb[j]!.size || [...ca[i]!].some((c) => cb[j]!.has(c));
  const candidates: Array<[number, number, number]> = [];
  ta.forEach((x, i) => {
    const k = shape(a[i]!);
    if (k !== null && common.has(k)) return;
    tb.forEach((y, j) => {
      const s = dice(x, y);
      // Same punctuation and keywords is not enough: `db, err := openDB(cfg.DSN)` is
      // not `exp, err := newExporter(cfg.TraceURL)`. In a short statement, where shapes repeat
      // by chance, most names and values must match too (60%); a long one is evidence by its length.
      if (s >= min && sameAction(i, j) && (x.length >= LONG_STATEMENT || !wa[i]!.length || dice(wa[i]!, wb[j]!) >= 0.6)) candidates.push([s, i, j]);
    });
  });
  candidates.sort((p, q) => q[0] - p[0] || p[1] - q[1] || p[2] - q[2]);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: Array<{ a: Node; b: Node; similarity: number }> = [];
  for (const [s, i, j] of candidates) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    out.push({ a: a[i]!, b: b[j]!, similarity: s });
  }
  return out.sort((p, q) => p.a.startIndex - q.a.startIndex);
}

/**
 * Where the helper's return value landed in the caller: an exact copy if there
 * is one, else the most similar fresh expression (the value may have been
 * edited along the way, e.g. wrapped in another call).
 */
function findReplacementAnywhere(
  body: Node,
  value: Node,
  after: number,
  inFresh: (n: Node) => boolean,
  minSimilarity: number,
  check: 'none' | 'keepNames' | 'sameCalls' = 'none',
  passedIn: Node | null = null,
  params: ReadonlySet<string> | null = null,
  substitution: { tokens: string[]; own: boolean[] } | null = null,
  grown: Node | null = null,
  other: Node | null = null
): Node | null {
  const exact = nodesWithTokens(body, tokens(value)).find((n) => n.startIndex >= after && inFresh(n));
  if (exact) return exact;
  const substituted = substitution?.tokens ?? null;
  const substitutedOwn = substitution?.own ?? null;
  // The value with the call's arguments in place of the parameters, found exactly:
  // `usesRegisterHooks(process.versions.node)` replaced `Number(process.versions.node.split('.')[0]) >= 26`.
  if (substituted && substituted.length >= SUBSTITUTED_MIN_TOKENS) {
    const hit = nodesWithTokens(body, substituted).find((n) => n.startIndex >= after && inFresh(n));
    if (hit) return hit;
  }
  // A value that grew around the old expression: the code the caller lost reads, in order,
  // inside the (substituted) value (`paths.sort().join(",")` became a helper that also
  // encodes commas). Only for a helper that is a single expression, and only a substantial
  // piece that calls something and is gone from the caller's other version (`grown`): one
  // still there was kept, perhaps edited, not moved.
  if (grown) {
    const full = substituted ?? tokens(value);
    const own = substitutedOwn ?? full.map(() => true);
    let hit: Node | null = null;
    const walk = (n: Node) => {
      if (hit) return;
      if (n.startIndex >= after && inFresh(n) && n.namedChildCount > 0) {
        const t = tokens(n);
        if (t.length >= GROWN_MIN_TOKENS && t.length < full.length && new Set(calledNames(t)).size >= 2 && distinctNames(t) >= 2 && ownInOrder(t, full, own) >= Math.max(4, t.length / 2) && !nodesWithTokens(grown, t).length) { hit = n; return; }
      }
      for (const c of n.namedChildren) if (c) walk(c);
    };
    walk(body);
    if (hit) return hit;
  }
  const want = tokens(value);
  const names = check === 'keepNames' ? want.filter((t) => /^[A-Za-z_$][\w$]*$/.test(t)) : [];
  // Calls in the arguments at the call site stand in for the helper's parameters.
  const wantCalls = new Set([...calledNames(want), ...(passedIn ? calledNames(tokens(passedIn)) : [])]);
  // The older code may not call anything the newer value does not (`Config.FileNames()` is not `Config.BaseDirectory()`).
  // With nothing else to go on, the candidate must also make the value's own calls:
  // `requireNonNull(in)` is not the bare `(in)` it was matched against.
  const valueCalls = check === 'none' ? [] : calledNames(want);
  const callsOk = (t: string[]) =>
    (check !== 'sameCalls' || calledNames(t).every((c) => wantCalls.has(c))) && valueCalls.every((c) => calledNames(t).includes(c));
  let best: Node | null = null;
  let bestScore = minSimilarity;
  const walk = (n: Node) => {
    if (n.startIndex >= after && inFresh(n) && n.namedChildCount > 0) {
      const t = tokens(n);
      if (t.length >= want.length / 2 && t.length <= want.length * 2) {
        const s = dice(want, t);
        if (s > bestScore && names.every((x) => t.includes(x)) && callsOk(t) && (params === null || sameOrder(want, t, params, VALUE_ORDER))) {
          bestScore = s;
          best = n;
        }
      }
    }
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(body);
  return best;
}

/**
 * Where the helper's return value landed, unless the caller's other version holds that
 * expression word for word as often as this one: then it was there all along and did not
 * come from the helper (a new `runValuesUncached` beside an unchanged `runValues`).
 */
function findReplacement(...args: Parameters<typeof findReplacementAnywhere>): Node | null {
  const found = findReplacementAnywhere(...args);
  const [body, , , , , , , , , , other] = args;
  if (!found || !other) return found;
  const t = tokens(found);
  return occurrences(other, t) >= occurrences(body, t) ? null : found;
}

/**
 * A one-line arrow helper has only its value to go on, so it must read the same: tokens in the same order (`a > b`
 * is not `b > a`), and every name it uses besides the helper's own parameters present
 * (`d.ownerId === u.id` is not `d.authorId === u.id`). A parameter matches any name.
 */
function sameOrder(want: string[], t: string[], params: ReadonlySet<string>, min: number): boolean {
  const ident = (x: string) => /^[#\p{L}_$][\p{L}\p{N}_$]*$/u.test(x);
  if (!want.every((x) => !ident(x) || params.has(x) || KEYWORDS.has(x) || t.includes(x))) return false;
  const eq = (a: string, b: string) => a === b || (params.has(a) && ident(b));
  let prev = new Array<number>(t.length + 1).fill(0);
  for (let i = 1; i <= want.length; i++) {
    const cur = new Array<number>(t.length + 1).fill(0);
    for (let j = 1; j <= t.length; j++) cur[j] = eq(want[i - 1]!, t[j - 1]!) ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    prev = cur;
  }
  return (2 * prev[t.length]!) / (want.length + t.length) >= min;
}

/** The old expression a grown value must contain, at least. */
const GROWN_MIN_TOKENS = 8;

/**
 * How many of `t`'s tokens come from the helper's own code (not the arguments put in its
 * place), when `t` reads in order inside `full`; 0 when it does not. An argument alone
 * turning up is no evidence: it was passed in either way.
 */
function ownInOrder(t: string[], full: string[], own: boolean[]): number {
  let j = 0;
  let mine = 0;
  full.forEach((x, i) => {
    if (j < t.length && x === t[j]) {
      if (own[i]) mine++;
      j++;
    }
  });
  return j === t.length ? mine : 0;
}

function distinctNames(t: string[]): number {
  return new Set(t.filter((x) => /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(x) && !KEYWORDS.has(x))).size;
}

/** A substituted value this short could turn up by chance. */
const SUBSTITUTED_MIN_TOKENS = 6;

/**
 * The helper's return value with each parameter replaced by the argument passed for it
 * at the call. Null when the call passes nothing that differs or the lists cannot be lined up.
 */
function substitutedValue(helper: FunctionInfo, value: Node, call: Node): { tokens: string[]; own: boolean[] } | null {
  const v = helper.node.childForFieldName('value');
  const list = helper.node.childForFieldName('parameters') ?? v?.childForFieldName('parameters') ?? v?.childForFieldName('parameter');
  const args = call.childForFieldName('arguments');
  if (!list || !args) return null;
  const nameOf = (p: Node): string | null => {
    const n = p.type === 'identifier' ? p : p.childForFieldName('pattern') ?? p.childForFieldName('name');
    return n && n.type === 'identifier' ? n.text : null;
  };
  const ps = list.type === 'identifier' ? [list] : list.namedChildren.filter((c): c is Node => !!c && !isComment(c));
  const as = args.namedChildren.filter((c): c is Node => !!c && !isComment(c));
  const map = new Map<string, string[]>();
  ps.forEach((p, i) => {
    const name = nameOf(p);
    if (name && as[i] && as[i]!.text !== name) map.set(name, tokens(as[i]!));
  });
  if (!map.size) return null;
  const out: string[] = [];
  const own: boolean[] = [];
  tokens(value).forEach((t, i, all) => {
    const arg = map.has(t) && all[i - 1] !== '.' ? map.get(t)! : null;
    for (const x of arg ?? [t]) { out.push(x); own.push(!arg); }
  });
  return { tokens: out, own };
}

/** How closely, in order, a value alone must match (a real one is copied nearly as is). */
const VALUE_ORDER = 0.9;

/** The names a function takes as parameters. */
function parameterNames(f: FunctionInfo): Set<string> {
  const v = f.node.childForFieldName('value');
  const list = f.node.childForFieldName('parameters') ?? v?.childForFieldName('parameters') ?? v?.childForFieldName('parameter');
  return new Set(list ? tokens(list).filter((x) => /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(x)) : []);
}

/** Names directly followed by `(`: the functions an expression calls. */
function calledNames(t: string[]): string[] {
  return t.filter((x, i) => t[i + 1] === '(' && /^[A-Za-z_$][\w$]*$/.test(x));
}

/** The helper's container: its header through the opening brace (and that line's break), and its closing brace. */
function containerRanges(helper: FunctionInfo, lines: string[]) {
  // A one-line arrow has no braces: its container is everything before the expression.
  if (helper.body.parent?.type === 'arrow_function' && helper.body.type !== 'statement_block') {
    return [range(pos(helper.node.startPosition), pos(helper.body.startPosition))];
  }
  const open = helper.body.child(0);
  const close = helper.body.child(helper.body.childCount - 1);
  if (!open || !close) throw new Error('function body without braces');
  const header = range(pos(helper.node.startPosition), pos(open.endPosition));
  const openLine = lines[open.endPosition.row] ?? '';
  // Nothing after the brace on its line: include the line break, as Pierre's producer does.
  if (openLine.slice(open.endPosition.column).trim() === '') header.end.character = openLine.length + 1;
  return [header, rangeOf(close)];
}

/** First line of the blank run directly above `line` (1-based), so a removed helper takes its separator with it. */
function withLeadingBlankLines(line: number, lines: string[]): number {
  let l = line;
  while (l > 1 && (lines[l - 2] ?? '').trim() === '') l--;
  return l;
}

// The "callers still call it" check counts only calls that could reach this helper (argument counts).

export function detectInlined(
  oldRoot: Node,
  newRoot: Node,
  oldText: string,
  cfg: LanguageConfig,
  options: InlineOptions = DEFAULT_INLINE_OPTIONS
): SemanticDiffOperation[] {
  const oldFns = functionsIn(oldRoot, cfg);
  const newFns = functionsIn(newRoot, cfg);
  const { counterpart, hasTwin } = pairFunctions(oldFns, newFns, oldRoot, newRoot, cfg);
  const oldLines = oldText.split('\n');
  const ops: SemanticDiffOperation[] = [];
  const common = boilerplate([oldRoot, newRoot], cfg);

  for (const helper of oldFns.filter((f) => {
    if (counterpart(f)) { why(f.name, 'not a candidate: it still exists on the other side'); return false; }
    if (hasTwin(f)) { why(f.name, 'its body reappears in another function (moved or renamed)'); return false; }
    return true;
  })) {
    // Debug only: why a helper never became a candidate with any caller.
    const seen = flags.reasons() ? { calledByUnpaired: 0, stillCalled: 0, candidates: 0 } : null;
    for (const caller of oldFns) {
      if (caller === helper) continue;
      const callerNew = counterpart(caller);
      if (!callerNew) {
        if (seen && callsTo(caller.node, helper.name, cfg, helper.node).some((c) => !(helper.node.startIndex <= c.startIndex && c.endIndex <= helper.node.endIndex))) seen.calledByUnpaired++;
        continue;
      }
      // A call inside the helper itself is recursion or a shadowing outer name, not a call site.
      const calls = callsTo(caller.node, helper.name, cfg, helper.node).filter((c) => !(helper.node.startIndex <= c.startIndex && c.endIndex <= helper.node.endIndex));
      if (!calls.length) continue;
      if (callsTo(callerNew.node, helper.name, cfg, rule('STILL_CALLED_ARITY') ? helper.node : undefined).length) { if (seen) seen.stillCalled++; continue; }
      if (seen) seen.candidates++;

      const c = makeCase({ helper, caller, callerNew, calls, oldFns, newFns, cfg, common, options });
      // Evidence 1: the helper's statements reappear one by one. Evidence 2, when statements changed
      // shape on the way (`x = A` in an if/else chain became `return A`): the helper's tokens line up,
      // in order, with the code the caller lost.
      let found = byStatements(c) ?? alignedTokens(c.stmts, c.fresh, helper.name, callerNew.body, caller.body, helper.node);
      // The rules above are strict on purpose. A candidate they reject can still be accepted by the
      // learned check (`classifier.ts`) or a second opinion (a decision model), each with its own guards.
      const secondOpinion = options.secondOpinion ?? currentSetup().secondOpinion;
      const learned = options.learned || flags.learned();
      const needEvidence = (!found && (learned || !!secondOpinion)) || flags.features();
      const ev = needEvidence ? evidence(c) : null;
      if (flags.features()) console.error('[feat] ' + JSON.stringify({ kind: options.mirrored ? 'extract' : 'inline', helper: helper.name, caller: caller.name, accepted: !!found, ...ev!.numbers, code: { helper: helper.node.text, caller: caller.node.text, callerNew: callerNew.node.text } }));
      if (!found && ev && learned) found = byLearnedCheck(c, ev);
      if (!found && ev && secondOpinion) found = bySecondOpinion(c, ev, secondOpinion);
      if (!found) continue;
      const { pairs, replacement } = found;
      ops.push(buildOperation({ helper, calls, ret: c.ret, pairs, replacement, oldLines }));
    }
    if (seen && !seen.candidates)
      why(helper.name, seen.stillCalled ? 'not a candidate: callers still call it' : seen.calledByUnpaired ? "not a candidate: its callers have no counterpart on the other side" : 'not a candidate: no call to it found');
  }
  return ops;
}

type Pair = { a: Node; b: Node; similarity: number };
type Found = { pairs: Pair[]; replacement: Node | null };

/** One helper and one caller that lost its calls to it (gained them, for an extract): what every rule judges. */
interface Case {
  helper: FunctionInfo; caller: FunctionInfo; callerNew: FunctionInfo; calls: Node[]; call: Node;
  /** The helper's statements; its final return (if any); the statements before it, which must move. */
  stmts: Node[]; ret: Node | null; moved: Node[];
  /** Statements new in the caller, outside closures new to it. */
  fresh: Node[];
  cfg: LanguageConfig; common: Set<string>; options: InlineOptions;
}

function makeCase(a: { helper: FunctionInfo; caller: FunctionInfo; callerNew: FunctionInfo; calls: Node[]; oldFns: FunctionInfo[]; newFns: FunctionInfo[]; cfg: LanguageConfig; common: Set<string>; options: InlineOptions }): Case {
  const { helper, caller, callerNew, calls, oldFns, newFns, cfg, common, options } = a;
  const stmts = helper.statements;
  const last = stmts.at(-1);
  const ret = last && cfg.isReturn(last, true) ? last : null;
  const moved = ret ? stmts.slice(0, -1) : stmts;
  const call = calls[0]!;

  // Statements that are new in the caller (not already present before).
  const before = new Set(allStatements(caller.body, cfg).map(key));
  // Code that landed in a named function nested inside the caller (a new
  // `const resolve = async () => { ... }`) went to that function, not into the caller.
  // That includes the statement declaring it (`const f = ...` wraps the function).
  // Only a closure new to the caller: one the helper or the caller already declared
  // can carry moved code along.
  const nested = newFns.filter((f) => f !== callerNew && callerNew.node.startIndex <= f.node.startIndex && f.node.endIndex <= callerNew.node.endIndex);
  const within = (outer: FunctionInfo) => oldFns.filter((f) => f !== outer && outer.node.startIndex <= f.node.startIndex && f.node.endIndex <= outer.node.endIndex).map((f) => f.name);
  const known = new Set([...within(helper), ...within(caller)]);
  const declares = (s: Node, f: FunctionInfo) =>
    !known.has(f.name) && f.node.startIndex >= s.startIndex && f.node.endIndex <= s.endIndex &&
    (f.node.parent?.id === s.id || (f.node.parent?.parent?.id === s.id && /declarator/.test(f.node.parent.type)));
  const fresh = allStatements(callerNew.body, cfg).filter(
    (s) => !before.has(key(s)) && !nested.some((f) => declares(s, f) || (f.node.startIndex <= s.startIndex && s.endIndex <= f.node.endIndex))
  );
  return { helper, caller, callerNew, calls, call, stmts, ret, moved, fresh, cfg, common, options };
}

/** The rule: the helper's statements reappear, one by one, in code new to the caller (and its value at the call's place). */
function byStatements(c: Case): Found | null {
  const { helper, caller, callerNew, calls, call, stmts, ret, moved, fresh, cfg, common, options } = c;
  // A statement the caller gained (or lost) that is closer to one in the caller's other
  // version than to the helper's stayed in the caller, edited: it did not move.
  const callerOwn = changedCallerStatements(caller, callerNew, calls, cfg);
  const pairs = pairStatements(moved, fresh, options.statementSimilarity, common).filter((p) => {
    const t = tokens(p.b);
    return !callerOwn.some((c) => dice(c, t) > p.similarity);
  });
  if (!pairs.length && moved.length) { why(helper.name, 'no statements reappear'); return null; }

  // The return value takes the call's place, inside code that is new in the caller.
  // With several call sites there is no single place, so the calls are just removed.
  const value = ret ? cfg.returnValueOf(ret) : null;
  const afterMoved = pairs.length ? pairs.at(-1)!.b.endIndex : callerNew.body.startIndex;
  const inFresh = (n: Node) => fresh.some((s) => s.startIndex <= n.startIndex && n.endIndex <= s.endIndex);
  // A loosely similar value is evidence only alongside moved statements. On its
  // own it must be close, and an inlined value must keep every name it used:
  // `s.snapshotHost.GetCurrentDirectory()` -> `s.GetCurrentDirectory()` calls
  // something else. (Extracts are left as they are: a call site often keeps
  // part of the old expression, which the hand labels count as real.)
  const check = pairs.length ? 'none' : options.mirrored ? 'sameCalls' : 'keepNames';
  // `const x = helper()` + `return x`: the helper's own `x` took over, so no expression replaced the
  // call. Looking for one anyway would land on some later use of `x` and claim that line.
  const replacement = value && calls.length === 1 && !assignsToSameName(call, value) ? findReplacement(callerNew.body, value, afterMoved, inFresh, pairs.length ? 0.6 : 0.8, check, call.childForFieldName('arguments'), !pairs.length && helper.body.type !== 'statement_block' && helper.body.parent?.type === 'arrow_function' ? parameterNames(helper) : null, substitutedValue(helper, value, call), !pairs.length && stmts.length === 1 ? caller.body : null, caller.body) : null;
  // No replacement expression: accept only when the call's result was stored in a
  // variable of the same name the helper returned (`const x = helper()` + `return x`),
  // so the helper's own `x` simply took over.
  // Boilerplate statements still count in the total: they cannot be evidence, but the helper is made of them.
  const helperTokens = stmts.reduce((n, s) => n + tokens(s).length, 0) || 1;
  // When most of the helper's statements came from the caller, its return value
  // may be new (`return true`, `return nil`): the moved code is evidence enough.
  const movedShare = pairs.reduce((n, p) => n + tokens(p.a).length * p.similarity, 0) / helperTokens;
  if (value && !replacement && calls.length === 1 && !assignsToSameName(call, value) && movedShare >= options.coverage) why(helper.name, `accepted without its return value: moved share ${movedShare.toFixed(2)} pairs=${pairs.length} sims=${pairs.map((p) => p.similarity.toFixed(2)).join(',')}`);
  if (value && !replacement && calls.length === 1 && !assignsToSameName(call, value) && movedShare < options.coverage) { why(helper.name, `return value ${value.text.slice(0, 40)} not found in new code`); return null; }

  // Something must really reappear: moved statements, or the returned value at the call's place.
  const valueFound = !!replacement || (value !== null && calls.length === 1 && assignsToSameName(call, value));
  if (!pairs.length && !valueFound) { why(helper.name, 'nothing reappears'); return null; }
  // A returned `false`, `nil` or bare name turning up somewhere is chance, not evidence.
  if (!pairs.length && value && tokens(value).length < 3) { why(helper.name, 'only a tiny return value reappears'); return null; }
  const covered =
    pairs.reduce((n, p) => n + tokens(p.a).length * p.similarity, 0) + (value && valueFound ? tokens(value).length : 0);
  if (covered / helperTokens < options.coverage) { why(helper.name, `coverage ${(covered / helperTokens).toFixed(2)}`); return null; }

  return { pairs, replacement };
}

/** The learned check (`classifier.ts`), with the rules' own guards on the statement pairs it shows. */
function byLearnedCheck(c: Case, ev: ReturnType<typeof evidence>): Found | null {
  const { helper, caller, callerNew, calls, cfg, options } = c;
  if (!likelyMoved(ev.numbers)) return null;
  // The learned check weighs evidence; the guards still apply. Its statement pairs must
  // survive the same tests as the rules' own: not closer to code the caller still has,
  // not still present in the caller as often as before. And a one-line helper is a
  // single value the rules already compare exactly (`a > b` is not `b > a`).
  const callerOwn = changedCallerStatements(caller, callerNew, calls, cfg);
  const pairs = ev.loose.filter((p) => !callerOwn.some((c) => dice(c, tokens(p.b)) > p.similarity) && !stillInCaller(tokens(p.b), helper, caller, callerNew));
  // And at least one statement must really reappear (a strict pair): the learned check
  // rescues near-misses of the rules, not lookalikes (`audit()` resembling a deleted check).
  const strict = pairs.some((p) => p.similarity >= options.statementSimilarity);
  if (!ev.numbers.oneLine && strict && pairs.reduce((n, p) => n + tokens(p.a).length, 0) >= LEARNED_MIN_TOKENS) {
    why(helper.name, `accepted by the learned check (p=${probabilityMoved(ev.numbers).toFixed(3)})`);
    return { pairs, replacement: null };
  }
  return null;
}

/** A decision model's answer (bring your own key), never asked about code still in the caller. */
function bySecondOpinion(c: Case, ev: ReturnType<typeof evidence>, ask: (candidate: Candidate) => boolean): Found | null {
  const { helper, caller, callerNew, stmts, options } = c;
  const kind = options.mirrored ? 'extract' : 'inline';
  const code = { helper: helper.node.text, caller: caller.node.text, callerNew: callerNew.node.text };
  // The engine checks the exact half of a move itself: the helper's statements must have left
  // the code that now calls it. A model judging meaning reads a copy as a move (micro tests:
  // copied code still in the caller scored "moved" 0.91), so copies never reach it.
  const helperToks = stmts.reduce((n, st) => n + tokens(st).length, 0) || 1;
  const copiedToks = stmts.reduce((n, st) => {
    const t = tokens(st);
    return t.length >= 4 && stillInCaller(t, helper, caller, callerNew, true) ? n + t.length : n;
  }, 0);
  const copied = currentSetup().secondOpinionCopyCheck !== false && copiedToks / helperToks >= 0.5;
  if (copied) why(helper.name, 'second opinion skipped: the helper\'s code is still in the caller');
  if (!copied && ask({ kind, helper: helper.name, caller: caller.name, code })) {
    why(helper.name, 'accepted by the second opinion');
    return { pairs: ev.loose, replacement: null };
  }
  return null;
}


/**
 * The evidence for one candidate (helper + caller) as plain numbers: how much of the helper
 * reappears in the code the caller lost (or gained), how closely, its size, its calls. The
 * learned check in `classifier.ts` weighs exactly these; SEMANTIC_FEATURES=1 logs them for training.
 */
function evidence(a: Case) {
  const { helper, callerNew, calls, stmts, moved, fresh, ret, cfg, common, options } = a;
  const helperToks = stmts.flatMap(tokens);
  const freshToks = outermost(fresh).flatMap(tokens);
  const strict = pairStatements(moved, fresh, options.statementSimilarity, common);
  const loose = pairStatements(moved, fresh, LOOSE_SIMILARITY, common);
  const share = (ps: Array<{ a: Node; similarity: number }>) => ps.reduce((n, p) => n + tokens(p.a).length * p.similarity, 0) / (helperToks.length || 1);
  const value = ret ? cfg.returnValueOf(ret) : null;
  const valueInFresh = value ? nodesWithTokens(callerNew.body, tokens(value)).some((n) => fresh.some((s) => s.startIndex <= n.startIndex && n.endIndex <= s.endIndex)) : false;
  const names = (t: string[]) => new Set(t.filter((x) => /^[A-Za-z_$][\w$]*$/.test(x)));
  const hn = names(helperToks);
  const fn = names(freshToks);
  return {
    loose,
    numbers: {
      helperTokens: helperToks.length, freshTokens: freshToks.length, statements: stmts.length, movedStatements: moved.length,
      strictPairs: strict.length, strictShare: share(strict), strictMeanSim: strict.length ? strict.reduce((n, p) => n + p.similarity, 0) / strict.length : 0,
      loosePairs: loose.length, looseShare: share(loose), bagDice: dice(helperToks, freshToks),
      nameOverlap: hn.size ? [...hn].filter((x) => fn.has(x)).length / hn.size : 0,
      hasValue: !!value, valueTokens: value ? tokens(value).length : 0, valueInFresh,
      calls: calls.length, oneLine: helper.body.type !== 'statement_block' && helper.body.parent?.type === 'arrow_function',
      sizeRatio: freshToks.length ? helperToks.length / freshToks.length : 0,
      extract: !!options.mirrored,
    } satisfies Evidence,
  };
}

/** Statement pairs this loose are shown for a candidate the learned check accepts; they are not evidence on their own. */
const LOOSE_SIMILARITY = 0.3;

/** The learned check needs this much of the helper paired with lost code to have something to show. */
const LEARNED_MIN_TOKENS = 10;

/** Fresh statements not inside another fresh statement. */
function outermost(nodes: Node[]): Node[] {
  return nodes.filter((n) => !nodes.some((m) => m !== n && m.startIndex <= n.startIndex && n.endIndex <= m.endIndex));
}

const CHUNK_MIN_TOKENS = 5;

/** How often code with exactly these tokens occurs in `root` (as a node). */
function occurrences(root: Node, t: string[]): number {
  return t.length >= CHUNK_MIN_TOKENS ? chunkCountsOf(root).get(t.join('\u0000')) ?? 0 : nodesWithTokens(root, t).length;
}

/**
 * Occurrences in the caller's old body, minus those inside the helper when the helper was nested in it, are
 * at least as many as in the caller's new body: this code did not leave the caller.
 */
function stillInCaller(t: string[], helper: FunctionInfo, caller: FunctionInfo, callerNew: FunctionInfo, atLeastOne = false): boolean {
  const own = helper.node.startIndex >= caller.body.startIndex && helper.node.endIndex <= caller.body.endIndex ? occurrences(helper.node, t) : 0;
  const after = occurrences(callerNew.body, t);
  return occurrences(caller.body, t) - own >= (atLeastOne ? Math.max(1, after) : after);
}

/**
 * The caller's statements that changed (gone from its other version), minus those holding a call to the
 * helper: the call takes the moved code's place. A statement closer to one of these than to the helper
 * stayed in the caller, edited; it did not move.
 */
function changedCallerStatements(caller: FunctionInfo, callerNew: FunctionInfo, calls: Node[], cfg: LanguageConfig): string[][] {
  const kept = new Set(allStatements(callerNew.body, cfg).map(key));
  return allStatements(caller.body, cfg)
    .filter((st) => !kept.has(key(st)) && !calls.some((c) => st.startIndex <= c.startIndex && c.endIndex <= st.endIndex))
    .map(tokens);
}

/** Chunk counts per caller body (by tree, then node id), reused across the helpers tried against it. */
const chunkCounts = new WeakMap<object, Map<number, Map<string, number>>>();

/** How often each piece of 5+ tokens occurs in `root`, cached. */
function chunkCountsOf(root: Node): Map<string, number> {
  let perTree = chunkCounts.get(root.tree);
  if (!perTree) chunkCounts.set(root.tree, (perTree = new Map()));
  const cached = perTree.get(root.id);
  if (cached) return cached;
  const m = new Map<string, number>();
  const walk = (n: Node) => {
    const t = tokens(n);
    if (t.length < CHUNK_MIN_TOKENS) return;
    const k = t.join('\u0000');
    m.set(k, (m.get(k) ?? 0) + 1);
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(root);
  perTree.set(root.id, m);
  return m;
}

const ALIGN_MIN_TOKENS = 15;
const ALIGN_SHARE = 0.6;

/**
 * Whole pieces of the helper (any syntax node of 5+ tokens) found verbatim in the
 * caller's lost (or gained) code, largest first. This survives statements changing
 * shape on the way (`x = A` in an if/else chain became `return A`), but not
 * scattered common tokens. The body span runs across the fresh statements touched.
 */
function alignedTokens(stmts: Node[], fresh: Node[], helperName: string, side: Node, other: Node, helper: Node): { pairs: Array<{ a: Node; b: Node; similarity: number }>; replacement: null } | null {
  const top = outermost(fresh);
  if (!stmts.length || !top.length) return null;
  // A piece the caller's other version holds as often as this one did not move: a changed
  // statement can be large (a whole nested `Effect.gen` block) and carry unchanged code along.
  const here = chunkCountsOf(side);
  const there = chunkCountsOf(other);
  // A helper declared inside the caller (common in Effect services) is not the caller's own code.
  const own = helper.startIndex >= other.startIndex && helper.endIndex <= other.endIndex ? chunkCountsOf(helper) : null;
  const kept = new Set([...here].filter(([k, n]) => (there.get(k) ?? 0) - (own?.get(k) ?? 0) >= n).map(([k]) => k));
  const where = new Map<string, number>();
  top.forEach((s, i) => {
    const walk = (n: Node) => {
      const t = tokens(n);
      if (t.length < CHUNK_MIN_TOKENS) return;
      const k = t.join('\u0000');
      if (!where.has(k) && !kept.has(k)) where.set(k, i);
      for (const c of n.namedChildren) if (c) walk(c);
    };
    walk(s);
  });
  let covered = 0;
  const touched = new Set<number>();
  const visit = (n: Node) => {
    const t = tokens(n);
    if (t.length < CHUNK_MIN_TOKENS) return;
    const i = where.get(t.join('\u0000'));
    if (i !== undefined) {
      covered += t.length;
      touched.add(i);
      return;
    }
    for (const c of n.namedChildren) if (c) visit(c);
  };
  for (const s of stmts) visit(s);
  const total = stmts.reduce((n, s) => n + tokens(s).length, 0) || 1;
  const share = covered / total;
  if (covered < ALIGN_MIN_TOKENS || share < ALIGN_SHARE) {
    why(helperName, `chunks found: ${covered} tokens, ${share.toFixed(2)} of helper`);
    return null;
  }
  const order = [...touched].sort((x, y) => x - y);
  const first = top[order[0]!]!;
  const lastTouched = top[order.at(-1)!]!;
  return { pairs: [{ a: stmts[0]!, b: first, similarity: share }, ...(lastTouched !== first ? [{ a: stmts.at(-1)!, b: lastTouched, similarity: share }] : [])], replacement: null };
}

function buildOperation(args: {
  helper: FunctionInfo;
  calls: Node[];
  ret: Node | null;
  pairs: Array<{ a: Node; b: Node }>;
  replacement: Node | null;
  oldLines: string[];
}): SemanticDiffOperation {
  const { helper, calls, ret, pairs, replacement, oldLines } = args;
  const call = calls[0]!;
  const first = helper.statements[0]!;
  const lastStmt = helper.statements.at(-1)!;
  // The moved code may have changed order: its span runs from the earliest to the latest piece.
  const movedNew = pairs.map((p) => p.b);
  const newFirst = movedNew.length ? movedNew.reduce((x, y) => (y.startIndex < x.startIndex ? y : x)) : undefined;
  const newLast = movedNew.length ? movedNew.reduce((x, y) => (y.endIndex > x.endIndex ? y : x)) : undefined;

  const spans: SemanticDiffOperation['spans'] = [];
  const BODY = spans.push({
    role: 'body',
    relation: 'moved',
    old: [range(pos(first.startPosition), pos(lastStmt.endPosition))],
    new: newFirst && newLast ? [range(pos(newFirst.startPosition), pos(newLast.endPosition))] : [],
    linePairs:
      newFirst && newLast
        ? [{ old: { start: startLine(first), end: endLine(lastStmt) }, new: { start: startLine(newFirst), end: endLine(newLast) } }]
        : [],
  }) - 1;
  const CALL = replacement
    ? spans.push({
        role: 'call',
        relation: 'replaced',
        old: [rangeOf(call)],
        new: [rangeOf(replacement)],
        linePairs: [{ old: { start: startLine(call), end: endLine(call) }, new: { start: startLine(replacement), end: endLine(replacement) } }],
      }) - 1
    : -1;
  const CALL_REMOVED = replacement ? -1 : spans.push({ role: 'call', relation: 'removed', old: calls.map(rangeOf) }) - 1;
  if (replacement) {
    spans.push({ role: 'focus', relation: 'replaced', old: [rangeOf(call)], new: [rangeOf(replacement)], linePairs: [] });
  }
  if (ret?.child(0)) spans.push({ role: 'focus', relation: 'removed', old: [rangeOf(ret.child(0)!)] });
  const CONTAINER = spans.push({ role: 'container', relation: 'removed', old: containerRanges(helper, oldLines) }) - 1;

  const bodyNewStart = newFirst ? startLine(newFirst) : replacement ? startLine(replacement) : startLine(call);
  const callNewEnd = replacement ? endLine(replacement) : newLast ? endLine(newLast) : bodyNewStart;
  const old: SemanticDiffLineRange[] = [];
  if (CALL >= 0) old.push({ start: startLine(call), end: endLine(call), spanIndex: CALL });
  if (CALL_REMOVED >= 0) {
    for (const c of calls) old.push({ start: startLine(c), end: endLine(c), spanIndex: CALL_REMOVED, attachment: { line: bodyNewStart, edge: 'before' } });
  }
  old.push({
    start: withLeadingBlankLines(startLine(helper.node), oldLines),
    end: startLine(first) - 1,
    spanIndex: CONTAINER,
    anchorIndex: 0,
    attachment: { line: bodyNewStart, edge: 'before' },
  });
  old.push({ start: startLine(first), end: endLine(lastStmt), spanIndex: BODY });
  old.push({
    start: endLine(lastStmt) + 1,
    end: endLine(helper.node),
    spanIndex: CONTAINER,
    anchorIndex: 1,
    attachment: { line: callNewEnd, edge: 'after' },
  });
  const added: SemanticDiffLineRange[] = [];
  if (newFirst && newLast) added.push({ start: startLine(newFirst), end: endLine(newLast), spanIndex: BODY });
  if (replacement && CALL >= 0) added.push({ start: startLine(replacement), end: endLine(replacement), spanIndex: CALL });

  const byStart = (a: SemanticDiffLineRange, b: SemanticDiffLineRange) => a.start - b.start;
  return { type: 'inlinedFunction', spans, lines: { old: old.sort(byStart), new: added.sort(byStart) } };
}
