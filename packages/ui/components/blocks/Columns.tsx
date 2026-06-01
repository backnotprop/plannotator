import React from 'react';
import { renderProseBody } from './proseBody';

interface ColumnsProps {
  blockId: string;
  body: string;
  columnCount?: number;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  githubRepo?: string;
  onNavigateAnchor?: (hash: string) => void;
}

/**
 * Split the :::cols body on :::col markers.
 * Each :::col ... ::: block becomes a column. Content before the first
 * :::col is ignored (or treated as a single column if no :::col markers).
 */
function parseColumns(body: string): string[] {
  // Split on :::col lines. The regex matches standalone :::col on its own line.
  const parts = body.split(/^:::col\s*$/m);

  // First element is content before the first :::col — drop it if empty
  const columns = parts
    .slice(1) // skip preamble
    .map(col => {
      // Remove a trailing ::: that closes the col container (if the
      // author used :::col ... ::: instead of relying on the parent :::)
      return col.replace(/^:::\s*$/m, '').trim();
    })
    .filter(Boolean);

  // Fallback: no :::col markers → treat the entire body as one column
  if (columns.length === 0 && body.trim()) {
    return [body.trim()];
  }

  return columns;
}

export const Columns: React.FC<ColumnsProps> = ({
  blockId,
  body,
  columnCount,
  imageBaseDir,
  onImageClick,
  onOpenLinkedDoc,
  onOpenCodeFile,
  githubRepo,
  onNavigateAnchor,
}) => {
  const columns = parseColumns(body);
  const count = columnCount || columns.length;

  const proseProps = {
    imageBaseDir,
    onImageClick,
    onOpenLinkedDoc,
    onOpenCodeFile,
    onNavigateAnchor,
    githubRepo,
  };

  return (
    <div
      className="directive-cols my-4"
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="cols"
    >
      <div
        className="directive-cols-grid gap-4"
        style={{ gridTemplateColumns: `repeat(${count}, 1fr)` }}
      >
        {columns.map((col, i) => (
          <div key={i} className="directive-col min-w-0">
            {renderProseBody({
              body: col,
              paragraphClassName: 'text-[15px] leading-relaxed text-foreground/90',
              listClassName: 'text-[15px] leading-relaxed text-foreground/90',
              ...proseProps,
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
