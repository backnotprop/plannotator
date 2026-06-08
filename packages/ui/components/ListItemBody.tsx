import React from 'react';
import { ListMarker } from './ListMarker';

/**
 * Shared list-item body: the marker plus the item's text content. Used by the
 * main Viewer (BlockRenderer) and the plan-diff clean view (both the inline
 * modified-block render and SimpleBlockRenderer).
 *
 * Callers own the surrounding row element so each surface keeps its own
 * concerns (indent, data attributes, hover-prop spread, diff wrapper classes).
 * This component owns the parts that must stay identical: marker selection and
 * the single-paragraph `<span>` vs multi-paragraph `<div><p>...</p></div>`
 * split, so a fix to either never has to be repeated per surface.
 */
interface ListItemBodyProps {
  level: number;
  ordered?: boolean;
  orderedIndex?: number | null;
  checked?: boolean; // undefined = not a checkbox
  interactive?: boolean;
  onToggle?: () => void;
  textClassName: string;
  content: string;
  renderInline: (text: string) => React.ReactNode;
}

export const ListItemBody: React.FC<ListItemBodyProps> = ({
  level,
  ordered,
  orderedIndex,
  checked,
  interactive,
  onToggle,
  textClassName,
  content,
  renderInline,
}) => {
  const paragraphs = content.split(/\n\n+/);
  return (
    <>
      <ListMarker
        level={level}
        ordered={ordered}
        orderedIndex={orderedIndex}
        checked={checked}
        interactive={interactive}
        onToggle={onToggle}
      />
      {paragraphs.length === 1 ? (
        <span className={textClassName}>{renderInline(content)}</span>
      ) : (
        <div className={textClassName}>
          {paragraphs.map((para, i) => (
            <p key={i} className={i > 0 ? 'mt-3' : ''}>
              {renderInline(para)}
            </p>
          ))}
        </div>
      )}
    </>
  );
};
