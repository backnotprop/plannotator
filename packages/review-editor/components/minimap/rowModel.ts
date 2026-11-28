export const ROW_ADD = 1;
export const ROW_DEL = 2;

export interface FileRowModel {
  rows: number;
  separators: number;
  flags: Uint8Array;
  oldLine: Int32Array;
  newLine: Int32Array;
  sepsBefore: Int32Array;
  additions: number;
  deletions: number;
}

export interface RowMetrics {
  headerHeight: number;
  lineHeight: number;
  separatorHeight: number;
  paddingBottom: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

class RowBuilder {
  flags: number[] = [];
  oldLine: number[] = [];
  newLine: number[] = [];
  sepsBefore: number[] = [];
  separators = 0;
  additions = 0;
  deletions = 0;

  push(flag: number, oldNo: number, newNo: number) {
    this.flags.push(flag);
    this.oldLine.push(oldNo);
    this.newLine.push(newNo);
    this.sepsBefore.push(this.separators);
  }

  block(dels: number[], adds: number[], split: boolean) {
    this.deletions += dels.length;
    this.additions += adds.length;
    if (split) {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) {
        const d = i < dels.length;
        const a = i < adds.length;
        this.push((d ? ROW_DEL : 0) | (a ? ROW_ADD : 0), d ? dels[i] : 0, a ? adds[i] : 0);
      }
      return;
    }
    for (const no of dels) this.push(ROW_DEL, no, 0);
    for (const no of adds) this.push(ROW_ADD, 0, no);
  }

  build(): FileRowModel {
    return {
      rows: this.flags.length,
      separators: this.separators,
      flags: Uint8Array.from(this.flags),
      oldLine: Int32Array.from(this.oldLine),
      newLine: Int32Array.from(this.newLine),
      sepsBefore: Int32Array.from(this.sepsBefore),
      additions: this.additions,
      deletions: this.deletions,
    };
  }
}

export function buildFileRowModel(patch: string, options: { split: boolean; expandUnchanged: boolean }): FileRowModel {
  const out = new RowBuilder();
  const lines = patch.split('\n');
  let i = 0;
  let nextOld = 1;
  let nextNew = 1;
  while (i < lines.length) {
    const header = HUNK.exec(lines[i]);
    i++;
    if (!header) continue;
    const oldStart = Number(header[1]);
    let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    const hidden = Math.max(0, (oldLeft === 0 ? oldStart + 1 : oldStart) - nextOld);
    if (hidden > 0) {
      if (options.expandUnchanged) {
        for (let k = 0; k < hidden; k++) out.push(0, nextOld + k, nextNew + k);
      } else {
        out.separators++;
      }
    }
    let oldNo = oldLeft === 0 ? oldStart + 1 : oldStart;
    let newNo = newLeft === 0 ? newStart + 1 : newStart;
    let dels: number[] = [];
    let adds: number[] = [];
    const flush = () => {
      if (dels.length || adds.length) out.block(dels, adds, options.split);
      dels = [];
      adds = [];
    };
    while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const line = lines[i];
      const mark = line[0];
      if (mark === '\\') {
        i++;
        continue;
      }
      if (mark === '-' && oldLeft > 0) {
        if (adds.length) flush();
        dels.push(oldNo++);
        oldLeft--;
      } else if (mark === '+' && newLeft > 0) {
        adds.push(newNo++);
        newLeft--;
      } else if ((mark === ' ' || line === '') && oldLeft > 0 && newLeft > 0) {
        flush();
        out.push(0, oldNo++, newNo++);
        oldLeft--;
        newLeft--;
      } else {
        break;
      }
      i++;
    }
    flush();
    nextOld = oldNo;
    nextNew = newNo;
  }
  return out.build();
}

export function rowOffset(model: FileRowModel, row: number, m: RowMetrics): number {
  const r = Math.max(0, Math.min(row, model.rows));
  const seps = r < model.rows ? model.sepsBefore[r] : model.separators;
  return r * m.lineHeight + seps * m.separatorHeight;
}

export function bodyHeight(model: FileRowModel, m: RowMetrics): number {
  return model.rows * m.lineHeight + model.separators * m.separatorHeight;
}

export function modelItemHeight(model: FileRowModel, m: RowMetrics, collapsed: boolean): number {
  if (collapsed) return m.headerHeight;
  return m.headerHeight + bodyHeight(model, m) + (model.rows > 0 ? m.paddingBottom : 0);
}

export function rowAtOffset(model: FileRowModel, offset: number, m: RowMetrics): number {
  let lo = 0;
  let hi = model.rows - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rowOffset(model, mid, m) <= offset) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function rowForLine(model: FileRowModel, line: number, side: 'old' | 'new'): number {
  const lines = side === 'old' ? model.oldLine : model.newLine;
  let best = -1;
  for (let r = 0; r < model.rows; r++) {
    const no = lines[r];
    if (no === line) return r;
    if (no > 0 && no < line) best = r;
  }
  return best;
}
