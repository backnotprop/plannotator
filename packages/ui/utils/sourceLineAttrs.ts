import type { Block } from '../types';
import { formatBlockSourceLineLabel } from './parser';

/**
 * The source-line label of one document block (Settings → Display → Source
 * line numbers), as an attribute for the block's own element:
 * `data-doc-source-line="42"` or `"42–45"`.
 *
 * There is no label element. theme.css draws the number as the block's
 * `::before`, only when the host opted in (`hooks/useDocumentSourceLineNumbers`
 * puts `data-doc-source-lines` on the document element) and only inside the
 * Viewer's article. So the switch never adds or removes a node (React would
 * insert in front of text the highlighter moved into a <mark> and unmount the
 * document), nothing that walks a block's children, text or offsets (block
 * targeting, the highlighter, copy, export) ever meets it, saved comment
 * positions are unchanged, and a host that never opts in (the Inbox, code
 * review) never shows it. Not on phones or in print.
 */
export function sourceLineAttrs(
  block?: Pick<Block, 'id' | 'startLine' | 'sourceLineCount' | 'type' | 'content' | 'alertKind'>,
  range?: { startLine: number; endLine?: number },
): { 'data-doc-source-line': string } | undefined {
  const label = block
    ? formatBlockSourceLineLabel(block)
    : range && range.startLine >= 1
      ? (range.endLine == null || range.endLine <= range.startLine ? String(range.startLine) : `${range.startLine}–${range.endLine}`)
      : null;
  return label ? { 'data-doc-source-line': label } : undefined;
}
