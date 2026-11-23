/**
 * The scenario table of a `:::question` block: a markdown table whose first
 * column names a situation and whose other headers each name a choice (its
 * label, or its first words), every cell `<verdict> — <detail>`. The card
 * draws it as its "Scenarios" section, scenarios as rows and options as
 * columns.
 *
 * Read strictly, so nothing an agent sends today changes: only a table whose
 * every option header names a different choice, with at least one body row,
 * within the caps below, is taken. Any other table (and every table when two
 * qualify) stays in the context, drawn as the markdown it is.
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
  for (const line of body) {
    const cells = splitScenarioRow(line);
    if (cells.length !== header.length || cells.some(tooLong)) return null;
    const situation = cells[0]!;
    if (!situation) return null;
    rows.push({ situation, cells: cells.slice(1).map(splitScenarioCell) });
  }
  return { columns, rows };
};

/**
 * The block's one scenario table among its context lines: the table and the
 * context indices it takes, or null when none (or more than one) qualifies.
 * A table is a run of lines starting with `|` at the block's own indent
 * (`blockIndent`, the prompt's), outside a code fence, as the renderer draws
 * one; its second line is the delimiter row.
 */
export const readQuestionScenarioTable = (
  contextLines: ReadonlyArray<string>,
  blockIndent: number,
  labels: string[],
  matchHeader: (header: string) => number,
): { table: QuestionScenarioTable; indices: number[] } | null => {
  if (labels.length === 0) return null;
  const found: { table: QuestionScenarioTable; indices: number[] }[] = [];
  let fence: string | null = null;
  for (let i = 0; i < contextLines.length; i++) {
    const line = contextLines[i]!;
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (fence || !line.trimStart().startsWith('|')) continue;
    const start = i;
    while (i + 1 < contextLines.length && contextLines[i + 1]!.trimStart().startsWith('|')) i++;
    const run = contextLines.slice(start, i + 1);
    if (run.some((l) => indentWidth(l) > blockIndent)) continue;
    const table = readTable(run, labels, matchHeader);
    if (table) found.push({ table, indices: run.map((_, k) => start + k) });
  }
  return found.length === 1 ? found[0]! : null;
};
