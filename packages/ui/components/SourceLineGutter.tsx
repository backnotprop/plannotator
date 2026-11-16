import React from 'react';
import type { Block } from '../types';
import { formatBlockSourceLineLabel } from '../utils/parser';

/**
 * Quiet source-line label for one document block (Settings → Display →
 * Source line numbers). Absolute, so it does not shift the document column.
 *
 * Always rendered and always empty: theme.css draws the number from
 * `data-doc-source-line` only when the host opted in
 * (`hooks/useDocumentSourceLineNumbers` puts `data-doc-source-lines` on the
 * document element) and only inside the Viewer's article. So flipping the
 * switch never inserts or removes a node in front of text the annotation
 * highlighter may have moved into a <mark> (React's insertBefore would throw
 * and unmount the document), a host that never opts in (the Inbox, code
 * review) never shows it, and it never joins copied text, annotation quotes
 * or text offsets. A custom tag so it never shifts the tag-indexed positions
 * stored with a highlight (web-highlighter counts elements by tag name).
 * Hidden on phones and in print.
 */
export const SourceLineGutter: React.FC<{
  block?: Pick<Block, 'id' | 'startLine' | 'sourceLineCount' | 'type' | 'content' | 'alertKind'>;
  startLine?: number;
  endLine?: number;
}> = ({ block, startLine, endLine }) => {
  const label = block
    ? formatBlockSourceLineLabel(block)
    : startLine != null && startLine >= 1
      ? (endLine == null || endLine <= startLine ? String(startLine) : `${startLine}–${endLine}`)
      : null;
  if (!label) return null;
  return React.createElement('pn-source-line', {
    'data-doc-source-line': label,
    'aria-hidden': 'true',
    className:
      'annotation-exclude pointer-events-none absolute right-full top-0 z-[1] mr-3 select-none whitespace-nowrap font-mono text-[11px] font-normal not-italic leading-4 tabular-nums text-muted-foreground/70',
  });
};
