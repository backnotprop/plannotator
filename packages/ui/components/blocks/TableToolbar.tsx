import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { buildCsv } from './TableBlock';

interface TableToolbarProps {
  element: HTMLElement;
  markdown: string;
  isExiting?: boolean;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onExpand?: () => void;
}

// Floats above a table on hover. Mirrors AnnotationToolbar's positioning +
// portal + entry/exit animation pattern so hover-triggered block toolbars
// all look and move the same way. Content is table-specific (copy markdown
// for now; CSV text button and expand icon planned). When a third use case
// appears we should factor the positioning shell into a shared hook.
export const TableToolbar: React.FC<TableToolbarProps> = ({
  element,
  markdown,
  isExiting = false,
  onMouseEnter,
  onMouseLeave,
  onExpand,
}) => {
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const [copiedMd, setCopiedMd] = useState(false);
  const [copiedCsv, setCopiedCsv] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updatePosition = () => {
      const rect = element.getBoundingClientRect();
      setPosition({
        top: rect.top - 40,
        right: window.innerWidth - rect.right,
      });
    };
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [element]);

  useEffect(() => {
    setCopiedMd(false);
    setCopiedCsv(false);
  }, [element]);

  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopiedMd(true);
      setTimeout(() => setCopiedMd(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleCopyCsv = async () => {
    try {
      await navigator.clipboard.writeText(buildCsv(markdown));
      setCopiedCsv(true);
      setTimeout(() => setCopiedCsv(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (!position) return null;

  const style: React.CSSProperties = {
    top: position.top,
    right: position.right,
    animation: isExiting
      ? 'table-toolbar-out 0.15s ease-in forwards'
      : 'table-toolbar-in 0.15s ease-out',
  };

  return createPortal(
    <div
      ref={toolbarRef}
      className="fixed z-[100] bg-popover border border-border rounded-md shadow-md"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <style>{`
        @keyframes table-toolbar-in {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes table-toolbar-out {
          from { opacity: 1; transform: translateY(0); }
          to { opacity: 0; transform: translateY(8px); }
        }
      `}</style>
      <div className="flex items-center p-0.5 gap-0.5">
        <button
          onClick={handleCopyMarkdown}
          title={copiedMd ? 'Copied!' : 'Copy as markdown'}
          className={`p-1 rounded transition-colors ${
            copiedMd ? 'text-success' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          {copiedMd ? <CheckIcon /> : <CopyIcon />}
        </button>
        <button
          onClick={handleCopyCsv}
          title={copiedCsv ? 'Copied as CSV!' : 'Copy as CSV'}
          className={`px-1.5 py-1 rounded text-[10px] font-bold tracking-tight uppercase leading-none transition-colors ${
            copiedCsv ? 'text-success' : 'text-primary hover:bg-primary/10'
          }`}
        >
          {copiedCsv ? '✓' : 'CSV'}
        </button>
        {onExpand && (
          <button
            onClick={onExpand}
            title="Expand table"
            className="p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <ExpandIcon />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};

const CopyIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

const ExpandIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
  </svg>
);
