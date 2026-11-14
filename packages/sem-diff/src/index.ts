// Entry point: two versions of a file in, Pierre semantic data out.
import { detectExtracted } from './extract.ts';
import { DEFAULT_INLINE_OPTIONS, detectInlined } from './inline.ts';
import { LANGUAGES, withTrees, type LanguageId } from './parse.ts';
import type { SemanticDiffFold, SemanticDiffLineRange, SemanticDiffOperation, SemanticDiffTextRange } from './pierre-types.ts';
import { detectStructure } from './structure.ts';
import { uncoveredChanges } from './coverage.ts';
import type { Node } from 'web-tree-sitter';
import { endLine, startLine } from './syntax.ts';
import { detectEdits, replacementsFromBlocks } from './edits.ts';
import { alignedLineDiff, diffLines, toPatch } from './linediff.ts';
import { computeTextDiff, WORK_PER_SECOND } from './textdiff.ts';
import { detectTextMoves } from './textmoves.ts';

export type { SemanticDiffFold, SemanticDiffOperation } from './pierre-types.ts';
export { languageForPath, type LanguageId } from './parse.ts';
export { configure, type Candidate, type SemDiffSetup, type WasmSource } from './runtime.ts';
export { reviewSummary, READ_KINDS, SKIM_KINDS, type ReviewSummary } from './summary.ts';
import type { Candidate } from './runtime.ts';
import { flags } from './runtime.ts';

export interface SemanticFileDiff {
  semanticOperations: SemanticDiffOperation[];
  semanticFolds: SemanticDiffFold[];
  /**
   * Unified diff built from the declaration-aware line diff. Hand it to Pierre
   * (`processFile(patch, { oldFile, newFile })`) so its layout matches the
   * operations; Pierre's own line diff can pair lines across functions.
   */
  patch: string;
  /** What each semantic pass did: how long it took, and whether it ran, failed or was skipped. */
  diagnostics: PassReport[];
}

export interface PassReport {
  pass: 'inline-extract' | 'second-opinion' | 'structure' | 'text-moves';
  ms: number;
  status: 'ok' | 'failed' | 'skipped';
  reason?: string;
}

export interface DiffOptions {
  /** Above this many characters (old + new), semantic passes are skipped: a plain diff only. Default 2,000,000. */
  maxChars?: number;
  /**
   * Once this many milliseconds have gone by, remaining semantic passes are skipped. Off by
   * default: timing depends on the machine, so a budget makes the output vary between runs.
   */
  timeBudgetMs?: number;
  /**
   * A second opinion on the extract/inline candidates the rules reject (bring your own model,
   * e.g. `jevOpinion({ apiKey })` from `@plannotator/sem-diff/opinions`). The engine collects
   * them, calls this once per file with all of them, and accepts those answered `true`. Never
   * asked about code still present in the caller. If it throws, the diff goes ahead without it.
   */
  secondOpinion?: (candidates: Candidate[]) => Promise<boolean[]>;
}

const DEFAULT_MAX_CHARS = 2_000_000;
const DEFAULT_TIME_BUDGET_MS = Number.POSITIVE_INFINITY;

/**
 * Pierre requires each line to belong to at most one operation per side.
 * Operations earlier in the list win; later ones keep their spans but lose
 * the lines already taken.
 */
function assignLines(ops: SemanticDiffOperation[]): SemanticDiffOperation[] {
  const taken = { old: new Set<number>(), new: new Set<number>() };
  return ops.map((op) => {
    const lines = { old: [] as SemanticDiffLineRange[], new: [] as SemanticDiffLineRange[] };
    for (const side of ['old', 'new'] as const) {
      for (const r of op.lines[side]) {
        let start = -1;
        for (let l = r.start; l <= r.end + 1; l++) {
          const free = l <= r.end && !taken[side].has(l);
          if (free && start < 0) start = l;
          if (!free && start >= 0) {
            lines[side].push({ ...r, start, end: l - 1 });
            start = -1;
          }
        }
        for (let l = r.start; l <= r.end; l++) taken[side].add(l);
      }
      lines[side].sort((a, b) => a.start - b.start);
    }
    return { ...op, lines };
  });
}

/**
 * A plain edit is worth showing only if it still owns a non-blank line (blank lines
 * around moves are noise), or a blank line inside a multi-line string, where it is
 * part of the string's value.
 */
function ownsText(op: SemanticDiffOperation, oldLines: string[], newLines: string[], inString: Sides): boolean {
  const any = (ranges: SemanticDiffLineRange[], lines: string[], keep: Set<number>) =>
    ranges.some((r) => lines.slice(r.start - 1, r.end).some((l, i) => l.trim() !== '' || keep.has(r.start + i)));
  return any(op.lines.old, oldLines, inString.old) || any(op.lines.new, newLines, inString.new);
}

/**
 * Changed lines that differ only in their indentation, anywhere (also inside
 * nested functions and callbacks, which are not declarations): formatting.
 * Not in Python, where indentation is meaning, nor inside multi-line strings.
 */
function reindented(blocks: ReturnType<typeof alignedLineDiff>, oldLines: string[], newLines: string[], inString: Sides, language: LanguageId): SemanticDiffOperation[] {
  if (language === 'python') return [];
  const out: SemanticDiffOperation[] = [];
  for (const b of blocks) {
    if (!b.old || !b.new || b.old.end - b.old.start !== b.new.end - b.new.start) continue;
    let ok = false;
    for (let i = 0; i <= b.old.end - b.old.start; i++) {
      const lo = b.old.start + i;
      const ln = b.new.start + i;
      const x = oldLines[lo - 1] ?? '';
      const y = newLines[ln - 1] ?? '';
      if (x.trim() !== y.trim() || inString.old.has(lo) || inString.new.has(ln)) {
        ok = false;
        break;
      }
      if (x.trim()) ok = true;
    }
    if (!ok) continue;
    const pair = { old: { start: b.old.start, end: b.old.end }, new: { start: b.new.start, end: b.new.end } };
    out.push({
      type: 'reformatted',
      spans: [
        {
          role: 'root',
          relation: 'mapped',
          old: [{ start: { line: pair.old.start, character: 0 }, end: { line: pair.old.end + 1, character: 0 } }],
          new: [{ start: { line: pair.new.start, character: 0 }, end: { line: pair.new.end + 1, character: 0 } }],
          linePairs: [pair],
        },
      ],
      lines: { old: [{ ...pair.old, spanIndex: 0 }], new: [{ ...pair.new, spanIndex: 0 }] },
    });
  }
  return out;
}

/**
 * Keep every operation inside the real lines. Half-written code can put a node past
 * the end (the parser supplies a missing `}` there), and an emptied file has no
 * line 1. An edit left without new lines is a deletion; an operation left with
 * nothing is dropped. Indices into the list shift, so this runs on the final list.
 */
function withinFile(ops: SemanticDiffOperation[], oldCount: number, newCount: number): SemanticDiffOperation[] {
  const count = { old: oldCount, new: newCount };
  const out: SemanticDiffOperation[] = [];
  for (const op of ops) {
    const lines = { old: [] as SemanticDiffLineRange[], new: [] as SemanticDiffLineRange[] };
    for (const side of ['old', 'new'] as const) {
      for (const r of op.lines[side]) {
        const otherCount = count[side === 'old' ? 'new' : 'old'];
        // Against an empty file there is no line to attach to: Pierre's `{ empty: true }`.
        if (r.attachment && 'line' in r.attachment && otherCount === 0) r.attachment = { empty: true };
        else if (r.attachment && 'line' in r.attachment && r.attachment.line > otherCount) r.attachment = { line: otherCount, edge: 'after' };
        const end = Math.min(r.end, count[side]);
        if (r.start <= end) lines[side].push({ ...r, end });
      }
    }
    if (!lines.old.length && !lines.new.length) continue;
    const pairsInside = op.spans.every((sp) => !('linePairs' in sp) || (sp.linePairs ?? []).every((p) => p.old.end <= count.old && p.new.end <= count.new && p.old.start <= p.old.end && p.new.start <= p.new.end));
    if (pairsInside && lines.old.length === op.lines.old.length && lines.new.length === op.lines.new.length && lines.old.every((l, i) => l.end === op.lines.old[i]!.end) && lines.new.every((l, i) => l.end === op.lines.new[i]!.end)) {
      out.push(op);
      continue;
    }
    const clip = (rs: SemanticDiffTextRange[] | undefined, side: 'old' | 'new') =>
      rs?.filter((r) => r.start.line <= count[side]).map((r) => (r.end.line > count[side] + 1 ? { ...r, end: { line: count[side] + 1, character: 0 } } : r));
    const spans = op.spans.map((sp) => {
      const x = sp as { old?: SemanticDiffTextRange[]; new?: SemanticDiffTextRange[] };
      const pairs = 'linePairs' in sp ? { linePairs: (sp.linePairs ?? []).filter((p) => p.old.end <= count.old && p.new.end <= count.new && p.old.start <= p.old.end && p.new.start <= p.new.end) } : {};
      return { ...sp, ...(x.old ? { old: clip(x.old, 'old') } : {}), ...(x.new ? { new: clip(x.new, 'new') } : {}), ...pairs } as typeof sp;
    });
    if (op.type === 'edited' && !lines.new.length) {
      const attach: { line: number; edge: 'after' } | { empty: true } = newCount ? { line: newCount, edge: 'after' } : { empty: true };
      const r = { start: { line: lines.old[0]!.start, character: 0 }, end: { line: lines.old.at(-1)!.end + 1, character: 0 } };
      out.push({ type: 'deleted', spans: [{ role: 'root', relation: 'removed', old: [r] }], lines: { old: lines.old.map((l) => ({ start: l.start, end: l.end, spanIndex: 0, attachment: attach })), new: [] } });
      continue;
    }
    out.push({ ...op, spans, lines });
  }
  return out;
}

/** Deepest bracket nesting in the text (strings and comments included: an estimate). */
function nestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 123 || c === 40 || c === 91) max = Math.max(max, ++depth);
    else if (c === 125 || c === 41 || c === 93) depth = Math.max(0, depth - 1);
  }
  return max;
}

/** Minified or bundled: some line over 1,000 characters and an average over 200. */
function minified(text: string): boolean {
  const lines = text.split('\n');
  return lines.some((l) => l.length > 1000) && text.length / lines.length > 200;
}

export type Sides = { old: Set<number>; new: Set<number> };

/** Lines strictly inside multi-line string literals (template strings, raw strings, text blocks...). */
function stringInteriors(root: Node, language?: LanguageId): Set<number> {
  const out = new Set<number>();
  const walk = (n: Node) => {
    if (n.endPosition.row === n.startPosition.row) return;
    if (/string|template|text_block/.test(n.type) && !/content|fragment/.test(n.type)) {
      // Rust drops the leading whitespace of a line continued with a backslash
      // ("...\\\n    more"), so re-indenting that line leaves the string as it was.
      const lines = n.text.split('\n');
      const continued = (k: number) => language === 'rust' && n.type === 'string_literal' && /(^|[^\\])(\\\\)*\\$/.test(lines[k - 1] ?? '');
      for (let l = startLine(n) + 1; l <= endLine(n); l++) if (!continued(l - startLine(n))) out.add(l);
      return;
    }
    for (const c of n.children) if (c) walk(c);
  };
  walk(root);
  return out;
}

const candidateKey = (c: Candidate) => [c.kind, c.helper, c.caller, c.code.helper, c.code.caller, c.code.callerNew].join('\u0000');

/**
 * A move with edits must still be mostly the same code. Two blocks sharing under a fifth of their
 * tokens are different code that happens to sit in the same place (an import paired with another
 * import, a function whose body was replaced and kept only its name): their lines are plain changes.
 * Audited on real commits: below 0.2, 4 of 22 wrong labels and 0 of 240 correct ones.
 */
const MOVED_WITH_EDIT_MIN_SIMILARITY = 0.2;
function alike(op: SemanticDiffOperation, oldLines: string[], newLines: string[]): boolean {
  const words = (lines: string[], rs: SemanticDiffLineRange[]) => rs.flatMap((r) => lines.slice(r.start - 1, r.end)).join('\n').match(/[A-Za-z_$][\w$]*|\d+|\S/g) ?? [];
  const a = words(oldLines, op.lines.old);
  const b = words(newLines, op.lines.new);
  const count = new Map<string, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  let common = 0;
  for (const y of b) {
    const n = count.get(y) ?? 0;
    if (n > 0) { common++; count.set(y, n - 1); }
  }
  return (2 * common) / (a.length + b.length || 1) >= MOVED_WITH_EDIT_MIN_SIMILARITY;
}

export async function semanticDiffFile(language: LanguageId, oldText: string, newText: string, name = 'file', options: DiffOptions = {}): Promise<SemanticFileDiff> {
  const cfg = LANGUAGES[language];
  const started = performance.now();
  // Bring-your-own-model second opinion: the engine is synchronous, the model is not. Collect the
  // candidates first, ask once, then run the diff with the answers looked up.
  let opinion: ((c: Candidate) => boolean) | undefined;
  const early: PassReport[] = [];
  const skipAll = oldText.length + newText.length > (options.maxChars ?? DEFAULT_MAX_CHARS) || minified(oldText) || minified(newText) || nestingDepth(oldText) > 80 || nestingDepth(newText) > 80;
  if (options.secondOpinion && !skipAll) {
    const t0 = performance.now();
    try {
      const asked: Candidate[] = [];
      const collect = { ...DEFAULT_INLINE_OPTIONS, secondOpinion: (c: Candidate) => (asked.push({ ...c, file: name }), false) };
      await withTrees(language, oldText, newText, (a, b) => {
        detectInlined(a.rootNode, b.rootNode, oldText, cfg, collect);
        detectExtracted(a.rootNode, b.rootNode, newText, cfg, collect);
      });
      const answers = asked.length ? await options.secondOpinion(asked) : [];
      const yes = new Set(asked.filter((_, i) => answers[i] === true).map(candidateKey));
      opinion = (c) => yes.has(candidateKey(c));
      early.push({ pass: 'second-opinion', ms: performance.now() - t0, status: 'ok', reason: `${asked.length} asked, ${yes.size} accepted` });
    } catch (e) {
      early.push({ pass: 'second-opinion', ms: performance.now() - t0, status: 'failed', reason: String(e).slice(0, 200) });
    }
  }
  const inlineOptions = opinion ? { ...DEFAULT_INLINE_OPTIONS, secondOpinion: opinion } : DEFAULT_INLINE_OPTIONS;
  return withTrees(language, oldText, newText, (a, b) => {
    // Order matters: earlier passes own the lines they explain (see assignLines).
    // Inline explains a whole helper's disappearance; declaration moves explain
    // whole functions; text moves cover statement blocks moved anywhere else.
    // Minified code has mangled names and one statement per line of thousands of
    // characters: claims about extracted or inlined functions mean nothing there.
    // Very deep nesting (generated code, fuzz input) makes per-statement work grow with depth.
    // Last resort: a semantic pass that fails on some input (a stack overflow on a
    // pathological tree) costs only its own findings; the file still gets a plain diff.
    // Guardrails: a very large file, or one that has used up its time budget, gets a plain diff
    // for the remaining passes instead of holding up the review. Every pass reports what it did.
    const diagnostics: PassReport[] = [...early];
    const tooBig = oldText.length + newText.length > (options.maxChars ?? DEFAULT_MAX_CHARS);
    const budget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
    const run = <T,>(pass: PassReport['pass'], f: () => T, fallback: T, skip?: string): T => {
      const reason = skip ?? (tooBig ? 'file too large' : performance.now() - started > budget ? 'time budget used up' : undefined);
      if (reason) {
        diagnostics.push({ pass, ms: 0, status: 'skipped', reason });
        return fallback;
      }
      const t0 = performance.now();
      try {
        const out = f();
        diagnostics.push({ pass, ms: performance.now() - t0, status: 'ok' });
        return out;
      } catch (e) {
        if (flags.reasons()) console.error('[semantic] pass failed:', e);
        diagnostics.push({ pass, ms: performance.now() - t0, status: 'failed', reason: String(e).slice(0, 200) });
        return fallback;
      }
    };
    const noInline = minified(oldText) || minified(newText) ? 'minified code' : nestingDepth(oldText) > 80 || nestingDepth(newText) > 80 ? 'nesting too deep' : undefined;
    const inlined = run('inline-extract', () => [...detectInlined(a.rootNode, b.rootNode, oldText, cfg, inlineOptions), ...detectExtracted(a.rootNode, b.rootNode, newText, cfg, inlineOptions)], [], noInline);
    const structure = run('structure', () => detectStructure(a.rootNode, b.rootNode, cfg), { operations: [], folds: [], paired: [] });
    const textDiff = computeTextDiff(oldText, newText, 0.4 * WORK_PER_SECOND);
    const text = run('text-moves', () => detectTextMoves(textDiff, oldText, newText), { operations: [], folds: [] });
    // A text move is redundant when every non-blank line it moves is already explained.
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const inString: Sides = { old: stringInteriors(a.rootNode, language), new: stringInteriors(b.rootNode, language) };
    const explained = new Set<number>();
    for (const o of [...inlined, ...structure.operations]) for (const l of o.lines.old) for (let n = l.start; n <= l.end; n++) explained.add(n);
    // A declaration the structure pass paired is placed by it: a text move that
    // carries whole declarations it kept in place sees the same swap from the
    // other side (A and B swapped: structure moves B, the text diff moves A).
    const covered = (op: SemanticDiffOperation) => {
      const whole = new Set<number>();
      for (const d of structure.paired)
        if (op.lines.old.some((l) => l.start <= d.start && d.end <= l.end)) for (let n = d.start; n <= d.end; n++) whole.add(n);
      return op.lines.old.every((l) => {
        for (let n = l.start; n <= l.end; n++) if ((oldLines[n - 1] ?? '').trim() !== '' && !explained.has(n) && !whole.has(n)) return false;
        return true;
      });
    };
    // A statement-block move comes from VS Code's diff, but the UI draws our own
    // line diff. Where the two disagree (an equal swap, a block crossing a function
    // boundary) the move would claim lines the patch shows as unchanged: drop it.
    const dOld = diffLines(oldText);
    const dNew = diffLines(newText);
    const blocks = alignedLineDiff(a.rootNode, b.rootNode, cfg, dOld, dNew);
    const changed: Sides = { old: new Set(), new: new Set() };
    for (const bl of blocks) {
      if (bl.old) for (let l = bl.old.start; l <= bl.old.end; l++) changed.old.add(l);
      if (bl.new) for (let l = bl.new.start; l <= bl.new.end; l++) changed.new.add(l);
    }
    const agrees = (op: SemanticDiffOperation) =>
      (['old', 'new'] as const).every((side) =>
        op.lines[side].every((r) => {
          const lines = side === 'old' ? oldLines : newLines;
          for (let l = r.start; l <= r.end; l++) if ((lines[l - 1] ?? '').trim() && !changed[side].has(l)) return false;
          return true;
        })
      );
    const textKept = text.operations.map((op, i) => ({ op, i })).filter(({ op }) => !covered(op) && agrees(op));
    // Plain edits go last: they describe only what no semantic pass explained.
    const explainedOps = [...inlined, ...structure.operations, ...textKept.map((t) => t.op), ...reindented(blocks, oldLines, newLines, inString, language)];
    const assigned = assignLines([...explainedOps, ...detectEdits(replacementsFromBlocks(blocks, oldText, newText), oldText, newText)]);
    // Drop operations left with nothing to show: semantic ones that lost every
    // line to an earlier pass (e.g. the same extract found from a second call
    // site), and plain edits that own only blank lines.
    const finalIndex = new Map<number, number>();
    const operations: SemanticDiffOperation[] = [];
    assigned.forEach((op, i) => {
      // A move, rename or formatting change relates lines on both sides: one that lost
      // either side to an earlier pass is no longer true (the safety net below then
      // marks the lines it still had as plain changes).
      const twoSided = op.type === 'moved' || op.type === 'movedWithEdit' || op.type === 'renamed' || op.type === 'reformatted';
      const keep =
        i < explainedOps.length
          ? twoSided
            ? op.lines.old.length > 0 && op.lines.new.length > 0
            : op.lines.old.length + op.lines.new.length > 0
          : ownsText(op, oldLines, newLines, inString);
      if (!keep || (op.type === 'movedWithEdit' && !alike(op, oldLines, newLines))) return;
      finalIndex.set(i, operations.length);
      operations.push(op);
    });
    operations.push(...uncoveredChanges(blocks, oldText, newText, operations, inString));
    const structureOffset = inlined.length;
    const textOffset = structureOffset + structure.operations.length;
    const textIndex = new Map(textKept.map(({ i }, k) => [i, textOffset + k]));
    const regionOps = [
      ...structure.folds.flatMap((r) => r.operations.map((i) => i + structureOffset)),
      ...text.folds.flatMap((r) => r.operations.filter((i) => textIndex.has(i)).map((i) => textIndex.get(i)!)),
    ].flatMap((i) => (finalIndex.has(i) ? [finalIndex.get(i)!] : []));
    // Fold rows follow the lines each move finally owns.
    const semanticFolds: SemanticDiffFold[] = regionOps
      .flatMap((index) =>
        operations[index]!.lines.old.map((l) => ({
          old: { start: l.start, end: l.end },
          operations: [index],
          counts: { moved: l.end - l.start + 1, edited: 0, removed: 0 },
        }))
      )
      .sort((x, y) => x.old.start - y.old.start);
    return { semanticOperations: withinFile(operations, dOld.length, dNew.length), semanticFolds, patch: toPatch(name, blocks, dOld, dNew), diagnostics };
  });
}

export async function semanticDiff(language: LanguageId, oldText: string, newText: string): Promise<SemanticDiffOperation[]> {
  return (await semanticDiffFile(language, oldText, newText)).semanticOperations;
}
