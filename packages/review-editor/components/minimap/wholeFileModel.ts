import { ROW_ADD, ROW_DEL, type FileRowModel } from './rowModel';
import type { LineSide } from './layoutSource';

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function buildWholeFileRowModel(patch: string, side: LineSide, lineCount: number): FileRowModel {
  const rows = Math.max(0, lineCount);
  const flags = new Uint8Array(rows);
  const own = new Int32Array(rows);
  for (let i = 0; i < rows; i++) own[i] = i + 1;
  let additions = 0;
  let deletions = 0;
  const mark = (line: number, flag: number) => {
    const index = Math.min(rows, Math.max(1, line)) - 1;
    if (index >= 0) flags[index] |= flag;
  };
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let pendingOpposite = false;
  const flushOpposite = () => {
    if (!pendingOpposite) return;
    if (side === 'new') mark(newNo, ROW_DEL);
    else mark(oldNo, ROW_ADD);
    pendingOpposite = false;
  };
  for (const line of patch.split('\n')) {
    const header = HUNK.exec(line);
    if (header) {
      flushOpposite();
      oldNo = Number(header[1]) || 1;
      newNo = Number(header[3]) || 1;
      if (header[2] === '0') oldNo += 1;
      if (header[4] === '0') newNo += 1;
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      additions++;
      if (side === 'new') mark(newNo, ROW_ADD);
      else pendingOpposite = true;
      newNo++;
    } else if (line.startsWith('-')) {
      deletions++;
      if (side === 'old') mark(oldNo, ROW_DEL);
      else pendingOpposite = true;
      oldNo++;
    } else {
      flushOpposite();
      oldNo++;
      newNo++;
    }
  }
  flushOpposite();
  return {
    rows,
    separators: 0,
    flags,
    oldLine: side === 'old' ? own : new Int32Array(rows),
    newLine: side === 'new' ? own : new Int32Array(rows),
    sepsBefore: new Int32Array(rows),
    additions,
    deletions,
  };
}
