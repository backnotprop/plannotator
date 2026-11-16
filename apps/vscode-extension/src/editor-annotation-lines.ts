interface EditorRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** Convert a VS Code selection to the review's one-based, inclusive line interval. */
export function editorAnnotationLines({ start, end }: EditorRange): { lineStart: number; lineEnd: number } {
  const excludesEndLine = end.line > start.line && end.character === 0;
  return { lineStart: start.line + 1, lineEnd: excludesEndLine ? end.line : end.line + 1 };
}
