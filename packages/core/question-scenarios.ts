/**
 * The scenario table of a `:::question` block: a markdown table whose first
 * column names a situation and whose other headers each name a choice (its
 * label, or its first words), every cell `<verdict> — <detail>`. The card
 * draws it as its "Scenarios" section, scenarios as rows and options as
 * columns.
 *
 * Read strictly, so nothing an agent sends today changes: only a table whose
 * every option header names a different choice, with at least one body row,
 * at least one cell written `<verdict> — <detail>` (an em dash with spaces),
 * within the caps below, is taken. Any other table (and every table when two
 * qualify) is only context, drawn as the markdown it is.
 *
 * Additive: the table's lines stay in the question's `context` (the stored
 * record and the wire carry them, so every reader that does not draw the
 * section shows the table as before). Only the card that draws the section
 * leaves them out of the context it renders (`contextWithoutScenarioTable`).
 *
 * Pure and browser-safe.
 */

/** One cell: the verdict (drawn bold) and the detail after ` — ` (quiet). Inline markdown, as written. */
export interface QuestionScenarioCell {
  verdict: string;
  /** The words after the first ` — ` (or ` – `) outside inline code. Absent when the cell has none. */
  detail?: string;
}

/** One option column: the choice it names (its label, as the question's choices carry it) and its header as written. */
export interface QuestionScenarioColumn {
  choice: string;
  header: string;
}

/** One scenario: the situation, in the agent's words, and one cell per column, in column order. */
export interface QuestionScenarioRow {
  situation: string;
  cells: QuestionScenarioCell[];
}

export interface QuestionScenarioTable {
  columns: QuestionScenarioColumn[];
  rows: QuestionScenarioRow[];
}

/** Past this many scenarios the table stays context. */
export const MAX_QUESTION_SCENARIO_ROWS = 8;
/** Past this many option columns the table stays context. */
export const MAX_QUESTION_SCENARIO_COLUMNS = 5;
/** A header, situation or cell longer than this (characters, as written) keeps the table as context. */
export const MAX_QUESTION_SCENARIO_CELL_CHARS = 240;

const DELIMITER_CELL_RE = /^:?-+:?$/;

/** A row's cells as GFM reads them: outer pipes dropped, split on each unescaped `|`, `\|` read as `|`. */
export const splitScenarioRow = (line: string): string[] => {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
};

/** `text` with every inline code span blanked to `x` (same length), so a dash inside code never splits a cell. */
const maskCode = (text: string): string => text.replace(/(`+)[^`][\s\S]*?\1/g, (m) => 'x'.repeat(m.length));

/** A cell split at its first ` — ` (or ` – `) outside inline code; no dash: all verdict. */
export const splitScenarioCell = (cell: string): QuestionScenarioCell => {
  const at = maskCode(cell).search(/\s[—–]\s/);
  if (at === -1) return { verdict: cell.trim() };
  const verdict = cell.slice(0, at).trim();
  const detail = cell.slice(at + 3).trim();
  return { verdict, ...(detail ? { detail } : {}) };
};

const indentWidth = (line: string): number => {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
};

/**
 * One table (its lines) as a scenario table, or null. `matchHeader` names the
 * choice (index) a header names, -1 for none; `labels` are the choices' labels.
 */
const readTable = (
  lines: string[],
  labels: string[],
  matchHeader: (header: string) => number,
): QuestionScenarioTable | null => {
  if (lines.length < 3) return null;
  const header = splitScenarioRow(lines[0]!);
  const delimiter = splitScenarioRow(lines[1]!);
  const optionCount = header.length - 1;
  if (optionCount < Math.min(2, labels.length) || optionCount < 1) return null;
  if (optionCount > labels.length || optionCount > MAX_QUESTION_SCENARIO_COLUMNS) return null;
  if (delimiter.length !== header.length || !delimiter.every((cell) => DELIMITER_CELL_RE.test(cell))) return null;
  const body = lines.slice(2);
  if (body.length === 0 || body.length > MAX_QUESTION_SCENARIO_ROWS) return null;
  const tooLong = (cell: string) => cell.length > MAX_QUESTION_SCENARIO_CELL_CHARS;
  if (header.some(tooLong)) return null;
  const columns: QuestionScenarioColumn[] = [];
  const seen = new Set<number>();
  for (const text of header.slice(1)) {
    if (!text) return null;
    const hit = matchHeader(text);
    if (hit < 0 || hit >= labels.length || seen.has(hit)) return null;
    seen.add(hit);
    columns.push({ choice: labels[hit]!, header: text });
  }
  const rows: QuestionScenarioRow[] = [];
  let verdictAndDetail = false;
  for (const line of body) {
    const cells = splitScenarioRow(line);
    if (cells.length !== header.length || cells.some(tooLong)) return null;
    const situation = cells[0]!;
    if (!situation) return null;
    if (!verdictAndDetail) verdictAndDetail = cells.slice(1).some(isVerdictAndDetail);
    rows.push({ situation, cells: cells.slice(1).map(splitScenarioCell) });
  }
  // An ordinary comparison table (`Yes` / `No` cells) is not a scenario table.
  return verdictAndDetail ? { columns, rows } : null;
};

/** A cell written `<verdict> — <detail>`: words, an em dash with spaces outside inline code, words. */
const isVerdictAndDetail = (cell: string): boolean => {
  const at = maskCode(cell).search(/\s—\s/);
  return at > 0 && cell.slice(0, at).trim() !== '' && cell.slice(at + 3).trim() !== '';
};

/**
 * The tables among `lines` as the card's markdown renderer finds them
 * (`packages/ui/utils/parser.ts`): a run of lines starting with `|`, outside a
 * code fence, that ends at the first line that does not (GFM would continue a
 * row without a leading pipe; the renderer does not, so neither does this).
 */
const tableRuns = (lines: ReadonlyArray<string>): { start: number; end: number }[] => {
  const runs: { start: number; end: number }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (fence || !line.trimStart().startsWith('|')) continue;
    const start = i;
    while (i + 1 < lines.length && lines[i + 1]!.trimStart().startsWith('|')) i++;
    runs.push({ start, end: i });
  }
  return runs;
};

/**
 * The block's one scenario table among its context lines: the table and the
 * context indices it spans, or null when none (or more than one) qualifies.
 * A table is a run of lines starting with `|` at the block's own indent
 * (`blockIndent`, the prompt's), outside a code fence, as the renderer draws
 * one (`tableRuns`); its second line is the delimiter row.
 */
export const readQuestionScenarioTable = (
  contextLines: ReadonlyArray<string>,
  blockIndent: number,
  labels: string[],
  matchHeader: (header: string) => number,
): { table: QuestionScenarioTable; indices: number[] } | null => {
  if (labels.length === 0) return null;
  const found: { table: QuestionScenarioTable; indices: number[] }[] = [];
  for (const { start, end } of tableRuns(contextLines)) {
    const run = contextLines.slice(start, end + 1);
    if (run.some((l) => indentWidth(l) > blockIndent)) continue;
    const table = readTable(run, labels, matchHeader);
    if (table) found.push({ table, indices: run.map((_, k) => start + k) });
  }
  return found.length === 1 ? found[0]! : null;
};

/** Whether a run of table lines is `table`: its option headers and its scenarios, as read. */
const isTable = (run: ReadonlyArray<string>, table: QuestionScenarioTable): boolean => {
  if (run.length !== table.rows.length + 2) return false;
  const header = splitScenarioRow(run[0]!).slice(1);
  if (header.length !== table.columns.length || header.some((h, i) => h !== table.columns[i]!.header)) return false;
  return run.slice(2).every((line, r) => splitScenarioRow(line)[0] === table.rows[r]!.situation);
};

/**
 * A question's context without its scenario table, for the card that draws the
 * table as its own section (so it is not shown twice). The table's lines leave
 * a paragraph break, so the paragraph above and the one below stay apart; a
 * table at either end leaves no blank line behind. A context without the
 * table (an edited record, a table that no longer matches) comes back as it is.
 */
export const contextWithoutScenarioTable = (context: string, table: QuestionScenarioTable): string => {
  const lines = context.split('\n');
  const run = tableRuns(lines).find(({ start, end }) => isTable(lines.slice(start, end + 1), table));
  if (!run) return context;
  const blank = (l: string | undefined) => l === undefined || l.trim() === '';
  const before = lines.slice(0, run.start);
  const after = lines.slice(run.end + 1);
  while (before.length && blank(before[before.length - 1])) before.pop();
  while (after.length && blank(after[0])) after.shift();
  return [...before, ...(before.length && after.length ? [''] : []), ...after].join('\n');
};
