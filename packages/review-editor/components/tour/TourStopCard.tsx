import React, { useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { TourStop, TourDiffAnchor } from '../../hooks/tour/useTourData';
import { DiffHunkPreview } from '../DiffHunkPreview';
import { renderInlineMarkdown } from '../../utils/renderInlineMarkdown';

function renderDetail(text: string): React.ReactNode[] {
  if (!text) return [];
  const nodes: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Callout block: > [!IMPORTANT] / > [!NOTE] / > [!WARNING]
    if (line.match(/^>\s*\[!(IMPORTANT|NOTE|WARNING)\]/i)) {
      const type = line.match(/WARNING/i) ? 'warning' : line.match(/IMPORTANT/i) ? 'important' : 'note';
      const calloutLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('>')) {
        calloutLines.push(lines[j].replace(/^>\s?/, ''));
        j++;
      }
      const calloutStyles = {
        important: 'bg-primary/[0.05] dark:bg-primary/[0.12] text-foreground',
        warning: 'bg-warning/[0.05] dark:bg-warning/[0.12] text-foreground',
        note: 'bg-muted/20 dark:bg-muted/40 text-foreground',
      };
      const calloutLabel = { important: 'Important', warning: 'Warning', note: 'Note' };
      nodes.push(
        <div key={key++} className={`my-2 px-3 py-2 rounded text-[12px] ${calloutStyles[type]}`}>
          <span className="font-semibold text-[10px] uppercase tracking-wider block mb-0.5 opacity-70">
            {calloutLabel[type]}
          </span>
          <span className="leading-relaxed">{renderInlineMarkdown(calloutLines.join(' '))}</span>
        </div>
      );
      i = j;
      continue;
    }

    // Heading h3
    if (line.startsWith('### ')) {
      nodes.push(
        <h3 key={key++} className="text-[12px] font-semibold text-foreground mt-3 mb-1">
          {line.slice(4)}
        </h3>
      );
      i++;
      continue;
    }

    // Bullet list
    if (line.match(/^[-*] /)) {
      const bullets: string[] = [line.slice(2)];
      let j = i + 1;
      while (j < lines.length && lines[j].match(/^[-*] /)) {
        bullets.push(lines[j].slice(2));
        j++;
      }
      nodes.push(
        <ul key={key++} className="my-1.5 space-y-0.5 pl-4">
          {bullets.map((b, bi) => (
            <li key={bi} className="text-[13px] text-foreground list-disc leading-relaxed">
              {renderInlineMarkdown(b)}
            </li>
          ))}
        </ul>
      );
      i = j;
      continue;
    }

    // Paragraph — collect until blank line or block element
    const paraLines: string[] = [line];
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() &&
      !lines[j].startsWith('### ') &&
      !lines[j].match(/^[-*] /) &&
      !lines[j].match(/^>\s*\[!/)
    ) {
      paraLines.push(lines[j]);
      j++;
    }
    nodes.push(
      <p key={key++} className="text-[13px] text-foreground leading-relaxed">
        {renderInlineMarkdown(paraLines.join(' '))}
      </p>
    );
    i = j;
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Inline anchor block
// ---------------------------------------------------------------------------

function AnchorBlock({
  anchor,
  onClick,
  parentOpen,
}: {
  anchor: TourDiffAnchor;
  onClick: () => void;
  /** Parent accordion state — DiffHunkPreview is deferred until first open. */
  parentOpen: boolean;
}) {
  // Lazy-mount: only create the heavy FileDiff web component on first expand.
  // The ref flips synchronously during render so the grid sees the correct height.
  const mountedRef = useRef(false);
  if (parentOpen) mountedRef.current = true;

  return (
    <div className="border border-border/20 dark:border-border/40 rounded-lg overflow-hidden">
      {/* File header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/20 dark:bg-muted/40 border-b border-border/15 dark:border-border/30">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-muted-foreground/50 flex-shrink-0">
          <path d="M3 1.5h6.5L13 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.2" />
          <path d="M9.5 1.5V5H13" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span className="text-[11px] font-mono text-muted-foreground truncate flex-1">
          {anchor.file}
        </span>
        <span className="text-[10px] text-muted-foreground/50 whitespace-nowrap flex-shrink-0">
          L{anchor.line}–{anchor.end_line}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onClick(); }}
          className="flex-shrink-0 text-[10px] text-primary/60 hover:text-primary transition-colors ml-1 font-medium"
        >
          Open ↗
        </button>
      </div>

      {/* Label */}
      {anchor.label && (
        <div className="px-3 py-2 text-[12px] text-foreground border-b border-border/10 dark:border-border/30 bg-muted/5 dark:bg-muted/20">
          {anchor.label}
        </div>
      )}

      {/* Diff preview — deferred until parent accordion first opens to avoid
          mounting all FileDiff web components on page load (causes jank) */}
      {mountedRef.current && (
        <DiffHunkPreview hunk={anchor.hunk} maxHeight={220} className="!border-0 !rounded-none" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stop card
// ---------------------------------------------------------------------------

interface TourStopCardProps {
  stop: TourStop;
  index: number;
  total: number;
  onAnchorClick: (filePath: string) => void;
  open: boolean;
  onToggle: () => void;
  /** True when another stop is open and this one isn't — fades to defocus. */
  dimmed?: boolean;
}

export const TourStopCard: React.FC<TourStopCardProps> = ({
  stop,
  index,
  total,
  onAnchorClick,
  open,
  onToggle,
  dimmed = false,
}) => {
  const isLast = index === total - 1;

  return (
    <div
      className={`relative pl-8 pb-6 transition-opacity duration-200 ease-out ${
        dimmed ? 'opacity-55' : 'opacity-100'
      }`}
    >
      {/* Timeline node */}
      <div className={`absolute left-0 top-1 -translate-x-1/2 w-5 h-5 rounded-full flex items-center justify-center border-2 border-background z-10 text-[9px] font-mono font-semibold transition-colors duration-200 ${
        open
          ? 'bg-primary text-primary-foreground'
          : 'bg-primary/10 dark:bg-primary/25 text-primary/70 dark:text-primary'
      }`}>
        {index + 1}
      </div>

      {/* Trigger */}
      <button className="w-full text-left group cursor-pointer" onClick={onToggle}>
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors duration-150">
              {stop.title}
            </span>
            <p className="text-[13px] text-foreground leading-relaxed mt-0.5">
              {stop.gist}
            </p>
          </div>
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            className={`flex-shrink-0 mt-1 text-muted-foreground/50 transition-transform duration-[250ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${open ? 'rotate-180' : ''}`}
          >
            <path d="M3.5 5.5L7 9L10.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </button>

      {/* Spring-animated accordion: height + opacity, with staggered child entrance */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { type: 'spring', stiffness: 180, damping: 24, mass: 0.7 },
              opacity: { duration: 0.18, ease: 'easeOut' },
            }}
            style={{ overflow: 'hidden' }}
          >
            <motion.div
              className="pt-3 space-y-2"
              initial="hidden"
              animate="visible"
              exit="hidden"
              variants={{
                hidden: { transition: { staggerChildren: 0.04, staggerDirection: -1 } },
                visible: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } },
              }}
            >
              <motion.div
                className="space-y-2"
                variants={{
                  hidden: { opacity: 0, y: -4 },
                  visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 200, damping: 22 } },
                }}
              >
                {renderDetail(stop.detail)}
              </motion.div>

              {stop.anchors.length > 0 && (
                <motion.div className="space-y-3 mt-3" variants={{ hidden: {}, visible: {} }}>
                  {stop.anchors.map((anchor, i) => (
                    <motion.div
                      key={`${anchor.file}:${anchor.line}-${i}`}
                      variants={{
                        hidden: { opacity: 0, y: 8 },
                        visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 200, damping: 22 } },
                      }}
                    >
                      <AnchorBlock
                        anchor={anchor}
                        onClick={() => onAnchorClick(anchor.file)}
                        parentOpen={open}
                      />
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Transition phrase */}
      {!isLast && stop.transition && (
        <p className="text-[11px] text-muted-foreground/50 italic mt-4">
          {stop.transition}
        </p>
      )}
    </div>
  );
};
