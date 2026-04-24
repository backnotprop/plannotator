import React, { useRef } from 'react';
import { Block } from '../../types';
import { InlineMarkdown } from '../InlineMarkdown';

interface TableBlockProps {
  block: Block;
  onHover?: (element: HTMLElement) => void;
  onLeave?: () => void;
  onOpenLinkedDoc?: (path: string) => void;
  onNavigateAnchor?: (hash: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  githubRepo?: string;
}

// Parse pipe-delimited markdown table content into headers + rows.
// Exported so TableToolbar can reuse it to build a CSV copy without
// needing a second parser.
export const parseTableContent = (content: string): { headers: string[]; rows: string[][] } => {
  const lines = content.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, '|'));

  const headers = parseRow(lines[0]);
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^[\|\-:\s]+$/.test(line)) continue; // separator row
    rows.push(parseRow(line));
  }
  return { headers, rows };
};

// RFC 4180 CSV escaping: quote values that contain a comma, double-quote,
// CR, or LF; escape inner double-quotes by doubling them.
const csvEscape = (value: string): string => {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

// Build RFC 4180 CSV from pre-parsed headers + rows. The popout uses this
// directly with TanStack's visible (filter + sort applied) rows.
export const buildCsvFromRows = (headers: string[], rows: string[][]): string => {
  const lines = [headers, ...rows].map((row) => row.map(csvEscape).join(','));
  return lines.join('\n');
};

// Rebuild a pipe-delimited markdown table from pre-parsed headers + rows.
// Inverse of parseTableContent. Whitespace normalized (one space per cell
// padding). The popout uses this for copy-as-markdown when filter or sort
// might change what the user sees.
// parseTableContent unescapes `\|` → `|`, so cells may hold literal pipes.
// Re-escape on the way out — otherwise the serialized table sprouts extra
// columns wherever a cell had a pipe.
const mdCellEscape = (value: string): string => value.replace(/\|/g, '\\|');

export const buildMarkdownTable = (headers: string[], rows: string[][]): string => {
  const headerLine = `| ${headers.map(mdCellEscape).join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.map((row) => `| ${row.map(mdCellEscape).join(' | ')} |`);
  return [headerLine, separator, ...bodyLines].join('\n');
};

// Convert the markdown table's pipe-delimited source into RFC 4180 CSV.
// The hover toolbar uses this on the raw block content (no filter state).
export const buildCsv = (markdown: string): string => {
  const { headers, rows } = parseTableContent(markdown);
  return buildCsvFromRows(headers, rows);
};

export const TableBlock: React.FC<TableBlockProps> = ({
  block,
  onHover,
  onLeave,
  onOpenLinkedDoc,
  onNavigateAnchor,
  imageBaseDir,
  onImageClick,
  githubRepo,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { headers, rows } = parseTableContent(block.content);

  const handleMouseEnter = () => {
    if (containerRef.current && onHover) onHover(containerRef.current);
  };

  return (
    <div
      ref={containerRef}
      className="my-4 overflow-x-auto"
      data-block-id={block.id}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onLeave}
    >
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            {headers.map((header, i) => (
              <th key={i} className="px-3 py-2 text-left font-semibold text-foreground/90 bg-muted/30">
                <InlineMarkdown
                  imageBaseDir={imageBaseDir}
                  onImageClick={onImageClick}
                  text={header}
                  onOpenLinkedDoc={onOpenLinkedDoc}
                  onNavigateAnchor={onNavigateAnchor}
                  githubRepo={githubRepo}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx} className="border-b border-border/50 hover:bg-muted/20">
              {row.map((cell, cellIdx) => (
                <td key={cellIdx} className="px-3 py-2 text-foreground/80">
                  <InlineMarkdown
                    imageBaseDir={imageBaseDir}
                    onImageClick={onImageClick}
                    text={cell}
                    onOpenLinkedDoc={onOpenLinkedDoc}
                    onNavigateAnchor={onNavigateAnchor}
                    githubRepo={githubRepo}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
