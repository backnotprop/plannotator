import type { SecondOpinionLink, SemanticDiffOperation } from '@plannotator/sem-jiff';
import { SKIM_KINDS } from '@plannotator/sem-jiff/summary';
import type { SemanticDiffChange } from '@plannotator/shared/semantic-diff-types';

const CHANGE_TYPE: Record<SemanticDiffOperation['type'], string> = {
  moved: 'moved',
  movedWithEdit: 'moved & edited',
  edited: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  reordered: 'reordered',
  reformatted: 'reformatted',
  extractedFunction: 'extracted',
  inlinedFunction: 'inlined',
};

const MAX_NAME = 80;
const ID = '[A-Za-z_$][\\w$]*';
const GENERIC = '<[^()]*>';
const KEYWORDS = 'function|def|fn|func|fun|class|interface|type|enum|const|let|var|val|struct|trait|impl|object|protocol|extension|module|record|namespace|typealias';
const MODIFIERS = 'export|default|declare|abstract|async|public|private|protected|internal|fileprivate|open|static|final|sealed|data|inner|value|annotation|companion|inline|suspend|operator|infix|tailrec|external|override|readonly|virtual|partial|unsafe|extern|mutating|nonmutating|convenience|required|dynamic|lazy|indirect|nonisolated|synchronized|pub(?:\\([^)]*\\))?';
const ATTRIBUTE = '@[\\w.]+(?:\\([^)]*\\))?\\s+|\\[[^\\]]*\\]\\s*';
const LEAD = `^\\s*(?:${ATTRIBUTE}|(?:${MODIFIERS}|${KEYWORDS})\\s+)*`;
const NAMED = new RegExp(
  `${LEAD}(?:${KEYWORDS})(?:\\s*\\*\\s*|\\s+)(?:\\([^)]*\\)\\s*)?(?:${GENERIC}\\s*)?(?:${ID}(?:${GENERIC})?\\??\\.)*(?!(?:${KEYWORDS})\\b)(${ID})`,
);
const RUST_IMPL = new RegExp(`${LEAD}impl\\s*(?:${GENERIC})?\\s+(?:[\\w:]+(?:${GENERIC})?\\s+for\\s+)?([\\w:]*?)(${ID})\\s*(?:${GENERIC})?\\s*(?:where\\b|\\{|$)`);
const PARAMS = '\\((?:[^()]|\\([^()]*\\))*\\)';
const METHOD = new RegExp(`^(?:(?:public|private|protected|static|async|readonly|override|get|set)\\s+)*\\*?(${ID})\\s*(?:${GENERIC})?\\s*${PARAMS}\\s*(?::\\s*[^=;{}]+)?\\{\\s*$`);
const TYPED_METHOD = new RegExp(
  `^\\s*((?:${ATTRIBUTE}|(?:${MODIFIERS})\\s+|${GENERIC}\\s+)*)(?:([A-Za-z_][\\w.]*(?:${GENERIC})?(?:\\[\\])*\\??)\\s+)?(${ID})\\s*(?:${GENERIC})?\\s*\\(`,
);
const TYPED_FILE = /\.(?:java|cs)$/i;
const NOT_A_NAME = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'return', 'function', 'else', 'elif', 'do', 'try', 'with', 'match', 'loop', 'when', 'guard', 'unless', 'until', 'using', 'lock', 'fixed', 'synchronized', 'new', 'throw', 'await', 'yield', 'case', 'goto', 'sizeof', 'typeof', 'nameof', 'default']);

function typedMethodName(line: string): string | null {
  const match = TYPED_METHOD.exec(line);
  if (!match) return null;
  const [, modifiers, type, name] = match;
  if (!modifiers && !type) return null;
  if (NOT_A_NAME.has(name!) || (type && NOT_A_NAME.has(type))) return null;
  return name!;
}

function declaredName(line: string, typed = false): string | null {
  const impl = RUST_IMPL.exec(line);
  if (impl) return impl[2]!;
  const named = NAMED.exec(line)?.[1];
  if (named) return named;
  const method = METHOD.exec(line.trim())?.[1];
  if (method && !NOT_A_NAME.has(method)) return method;
  return typed ? typedMethodName(line) : null;
}

export function shortName(line: string, filePath = ''): string {
  return declaredName(line, TYPED_FILE.test(filePath)) ?? line;
}

const OPEN_BRACE = /^\s*\{\s*$/;
const indentOf = (line: string) => /^\s*/.exec(line)![0].length;
const LOCAL = /^\s+(?:const|let|var)\b|^\s*for\b/;
const ownerName = (line: string, typed: boolean) => (LOCAL.test(line) ? null : declaredName(line, typed));

function enclosingName(text: string, line: number | undefined, typed: boolean): string | null {
  if (line == null) return null;
  const lines = text.split('\n');
  const own = lines[line - 1] ?? '';
  if (ownerName(own, typed)) return null;
  let indent = own.trim() === '' ? Infinity : indentOf(own);
  for (let at = line - 2; at >= 0; at--) {
    const value = lines[at]!;
    if (value.trim() === '' || OPEN_BRACE.test(value)) continue;
    const here = indentOf(value);
    if (here >= indent) continue;
    indent = here;
    const name = ownerName(value, typed);
    if (name) return name;
    if (here === 0) return null;
  }
  return null;
}

const MEANINGLESS = /^[^\p{L}\p{N}_$]*$/u;

function lineText(text: string, line: number | undefined): string {
  if (line == null) return '';
  const value = text.split('\n')[line - 1]?.trim() ?? '';
  return value.length > MAX_NAME ? `${value.slice(0, MAX_NAME - 1)}…` : value;
}

function firstLine(text: string, line: number | undefined): string {
  return lineText(text, line);
}

function declarationLine(text: string, ranges: readonly { start: number; end: number }[]): string {
  for (const range of ranges) {
    for (let line = range.start; line <= range.end && line < range.start + 40; line++) {
      const value = lineText(text, line);
      if (/\b(function|def|fn|func|fun|class)\b/.test(value)) return value;
    }
  }
  return '';
}

type Folded = SemanticDiffChange & { folded: boolean };

type Rename = { oldName: string; newName: string; oldStart: number; oldEnd: number; newStart: number; newEnd: number };
type TextRange = { start: { line: number; character: number }; end: { line: number; character: number } };

function sigilFor(path: string): RegExp | null {
  if (/\.(php|phtml)$/i.test(path)) return /\$$/;
  if (/\.(rb|rake|gemspec)$/i.test(path) || /(^|\/)(Rakefile|Gemfile)$/.test(path)) return /(?:@@?|(?<![:\w]):)$/;
  return null;
}

function rangeText(lines: string[], range: TextRange | undefined, sigil: RegExp | null): string {
  if (!range || range.start.line !== range.end.line) return '';
  const line = lines[range.start.line - 1] ?? '';
  const word = line.slice(range.start.character, range.end.character);
  const lead = sigil?.exec(line.slice(0, range.start.character))?.[0] ?? '';
  return word.startsWith(lead) ? word : lead + word;
}

function renamesOf(op: SemanticDiffOperation, oldLines: string[], newLines: string[], oldSigil: RegExp | null, newSigil: RegExp | null): Rename[] {
  if (op.type !== 'renamed') return [];
  return (op.spans ?? []).flatMap((span) => {
    if (span.relation !== 'replaced') return [];
    const oldName = rangeText(oldLines, span.old[0], oldSigil);
    const newName = rangeText(newLines, span.new[0], newSigil);
    if (!oldName || !newName || oldName === newName) return [];
    const oldRows = span.old.map((range) => range.start.line);
    const newRows = span.new.map((range) => range.start.line);
    return [{ oldName, newName, oldStart: Math.min(...oldRows), oldEnd: Math.max(...oldRows), newStart: Math.min(...newRows), newEnd: Math.max(...newRows) }];
  });
}

function mergeInto(target: Folded, change: Folded): void {
  if (target.changeType !== change.changeType) target.changeType = 'modified';
  const low = (x: number | null, y: number | null) => (x == null ? y : y == null ? x : Math.min(x, y));
  const high = (x: number | null, y: number | null) => (x == null ? y : y == null ? x : Math.max(x, y));
  target.startLine = low(target.startLine, change.startLine);
  target.endLine = high(target.endLine, change.endLine);
  target.oldStartLine = low(target.oldStartLine, change.oldStartLine);
  target.oldEndLine = high(target.oldEndLine, change.oldEndLine);
  target.structuralChange = target.structuralChange || change.structuralChange;
}

export function semDiffChanges(
  filePath: string,
  operations: SemanticDiffOperation[],
  oldText: string,
  newText: string,
  oldFilePath: string | null = null,
  links: readonly SecondOpinionLink[] = [],
): SemanticDiffChange[] {
  const typed = TYPED_FILE.test(filePath);
  const named = (line: string) => declaredName(line, typed) ?? line;
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldSigil = sigilFor(oldFilePath ?? filePath);
  const newSigil = sigilFor(filePath);
  const rows: Folded[] = operations.flatMap((op, index): Folded[] => {
    const link = links.find((candidate) => candidate.operationIndex === index);
    const linked = link ? { origin: 'second-opinion' as const, band: link.band, model: link.model, candidateId: link.candidateId } : {};
    const renames = renamesOf(op, oldLines, newLines, oldSigil, newSigil);
    if (renames.length > 0) {
      return renames.map((rename) => ({
        entityId: null,
        changeType: CHANGE_TYPE.renamed,
        entityType: '',
        entityName: rename.newName,
        oldEntityName: rename.oldName,
        filePath,
        oldFilePath,
        startLine: rename.newStart,
        endLine: rename.newEnd,
        oldStartLine: rename.oldStart,
        oldEndLine: rename.oldEnd,
        structuralChange: !SKIM_KINDS.includes(op.type),
        ...linked,
        folded: false,
      }));
    }
    const oldRange = op.lines.old[0];
    const newRange = op.lines.new[0];
    const oldEnd = op.lines.old.at(-1)?.end ?? null;
    const newEnd = op.lines.new.at(-1)?.end ?? null;
    const helper = op.type === 'extractedFunction'
      ? declarationLine(newText, op.lines.new)
      : op.type === 'inlinedFunction'
        ? declarationLine(oldText, op.lines.old)
        : '';
    const name = helper || firstLine(newText, newRange?.start) || firstLine(oldText, oldRange?.start);
    const oldName = firstLine(oldText, oldRange?.start);
    const owner = helper || op.type === 'renamed' ? null : newRange ? enclosingName(newText, newRange.start, typed) : enclosingName(oldText, oldRange?.start, typed);
    return [{
      entityId: null,
      changeType: CHANGE_TYPE[op.type] ?? 'modified',
      entityType: '',
      entityName: owner ?? named(name),
      oldEntityName: !owner && op.type === 'renamed' && oldName && named(oldName) !== named(name) ? named(oldName) : null,
      filePath,
      oldFilePath,
      startLine: newRange?.start ?? null,
      endLine: newEnd,
      oldStartLine: oldRange?.start ?? null,
      oldEndLine: oldEnd,
      structuralChange: !SKIM_KINDS.includes(op.type),
      ...linked,
      folded: owner !== null && !link,
    }];
  });
  const out: Folded[] = [];
  const byName = new Map<string, Folded>();
  for (const row of rows) {
    if (MEANINGLESS.test(row.entityName.trim())) continue;
    const kept = row.candidateId ? undefined : byName.get(row.entityName);
    if (kept && !kept.candidateId && (kept.folded || row.folded)) {
      mergeInto(kept, row);
      kept.folded = true;
      continue;
    }
    const pair = kept && !kept.candidateId && kept.changeType !== row.changeType && [kept.changeType, row.changeType].every((type) => type === 'added' || type === 'deleted');
    if (kept && pair) {
      mergeInto(kept, row);
      kept.changeType = 'modified';
      continue;
    }
    if (!kept && !row.candidateId) byName.set(row.entityName, row);
    out.push(row);
  }
  return out.map(({ folded: _folded, ...change }) => change);
}
