export interface WholeFileMarks {
  added: number[];
  modified: number[];
  removedBefore: number[];
}

export function wholeFileMarks(patch: string): WholeFileMarks {
  const marks: WholeFileMarks = { added: [], modified: [], removedBefore: [] };
  let newLine = 0;
  let inHunk = false;
  let removed = 0;
  let addedRun: number[] = [];
  const flush = () => {
    if (addedRun.length > 0) {
      (removed > 0 ? marks.modified : marks.added).push(...addedRun);
    } else if (removed > 0) {
      marks.removedBefore.push(Math.max(1, newLine));
    }
    removed = 0;
    addedRun = [];
  };
  for (const line of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      flush();
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      addedRun.push(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
    } else if (line.startsWith('\\')) {
      continue;
    } else {
      flush();
      newLine += 1;
    }
  }
  flush();
  return marks;
}

function selectorList(lines: readonly number[]): string {
  return lines.map((line) => `[data-gutter] [data-column-number="${line}"]`).join(',\n');
}

export function wholeFileMarksCss(marks: WholeFileMarks): string {
  const rules: string[] = [];
  if (marks.added.length > 0) {
    rules.push(`${selectorList(marks.added)} { box-shadow: inset -3px 0 0 var(--diffs-addition-base, #3fb950); }`);
  }
  if (marks.modified.length > 0) {
    rules.push(`${selectorList(marks.modified)} { box-shadow: inset -3px 0 0 var(--diffs-modified-base, #388bfd); }`);
  }
  if (marks.removedBefore.length > 0) {
    rules.push(
      `${selectorList(marks.removedBefore)} { background-image: linear-gradient(135deg, transparent 50%, var(--diffs-deletion-base, #f85149) 50%); background-size: 6px 6px; background-position: right top; background-repeat: no-repeat; }`,
    );
  }
  return rules.join('\n');
}
