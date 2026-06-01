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
 */
function parseColumns(body: string): string[] {
  const parts = body.split(/^:::col\s*$/m);
  const columns = parts
    .slice(1)
    .map(col => col.replace(/^:::\s*$/m, '').trim())
    .filter(Boolean);

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
      {/* Design-system spec: gap 24px, responsive at 720px */}
      <div
        className="directive-cols-grid"
        style={{ gap: '24px', gridTemplateColumns: `repeat(${count}, 1fr)` }}
      >
        {columns.map((col, i) => (
          <div key={i} className="directive-col min-w-0">
            {renderProseBody({
              body: col,
              paragraphClassName: 'leading-relaxed text-foreground/90',
              listClassName: 'leading-relaxed text-foreground/90',
              ...proseProps,
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
