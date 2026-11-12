export interface EmbedInsertPlan {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly cursor: number;
}

export function planEmbedInsert(
  body: string,
  from: number,
  to: number,
  embedLine: string,
): EmbedInsertPlan {
  let lineStart = body.lastIndexOf('\n', from - 1) + 1;
  if (from === 0) lineStart = 0;

  let prefix = '';
  if (lineStart > 0) {
    const previousLineStart = body.lastIndexOf('\n', lineStart - 2) + 1;
    const previousLine = body.slice(previousLineStart, lineStart - 1);
    if (!/^\s*$/.test(previousLine)) prefix = '\n';
  }

  let lineEnd = body.indexOf('\n', to);
  if (lineEnd === -1) lineEnd = body.length;
  const restOfLine = body.slice(to, lineEnd);
  let suffix: string;
  if (!/^\s*$/.test(restOfLine)) {
    suffix = '\n\n';
  } else if (lineEnd >= body.length) {
    suffix = '\n';
  } else {
    let nextLineEnd = body.indexOf('\n', lineEnd + 1);
    if (nextLineEnd === -1) nextLineEnd = body.length;
    const nextLine = body.slice(lineEnd + 1, nextLineEnd);
    suffix = /^\s*$/.test(nextLine) ? '' : '\n';
  }

  const embedEnd = lineStart + prefix.length + embedLine.length;
  return {
    from: lineStart,
    to: /^\s*$/.test(restOfLine) ? lineEnd : to,
    insert: prefix + embedLine + suffix,
    cursor: embedEnd + 1,
  };
}
