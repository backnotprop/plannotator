import React from 'react';
import { useConfigValue } from '../config';
import type { Block } from '../types';
import { formatBlockSourceLineLabel } from '../utils/parser';

/**
 * Quiet source-line label for one document block (Settings → Display →
 * Source line numbers). Absolute, so it does not shift the document column
 * or join copied / annotated text. Hidden on phones (`md`) and in print.
 */
export const SourceLineGutter: React.FC<{
  block?: Pick<Block, 'id' | 'startLine' | 'sourceLineCount' | 'type' | 'content' | 'alertKind'>;
  startLine?: number;
  endLine?: number;
}> = ({ block, startLine, endLine }) => {
  const show = useConfigValue('documentSourceLineNumbers');
  if (!show) return null;
  const label = block
    ? formatBlockSourceLineLabel(block)
    : startLine != null && startLine >= 1
      ? (endLine == null || endLine <= startLine ? String(startLine) : `${startLine}–${endLine}`)
      : null;
  if (!label) return null;
  return (
    <span
      data-doc-source-line={label}
      aria-hidden="true"
      className="annotation-exclude pointer-events-none absolute right-full top-0 z-[1] mr-3 hidden select-none whitespace-nowrap font-mono text-[11px] leading-4 tabular-nums text-muted-foreground/70 md:block print:hidden"
    >
      {label}
    </span>
  );
};
