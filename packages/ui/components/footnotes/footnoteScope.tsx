/**
 * A document's footnote scope (`Footnotes.tsx` explains the whole), apart so
 * `InlineMarkdown` can draw a reference without importing the notes list.
 */
import React, { createContext, useContext, useId, useMemo, useRef } from 'react';
import type { Block } from '../../types';
import { indexFootnotes, type FootnoteIndex } from '../../utils/footnotes';

export interface FootnoteScope {
  idPrefix: string;
  numbers: ReadonlyMap<string, number>;
  /** The reference the reader last followed, so the back link returns there. */
  lastRef: { current: HTMLElement | null };
}

const FootnoteContext = createContext<FootnoteScope | null>(null);

/** The surface's footnote scope, read by `InlineMarkdown`. */
export const useFootnoteScope = (): FootnoteScope | null => useContext(FootnoteContext);

export const noteId = (scope: FootnoteScope, n: number): string => `${scope.idPrefix}-fn-${n}`;

/** Scroll to an element and hand it focus, so keyboard and screen-reader users move with the view. */
export function goTo(target: HTMLElement): void {
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
}

/** The document's notes, or null when it has none. */
export function useFootnotes(blocks: readonly Block[]): FootnoteIndex | null {
  return useMemo(() => indexFootnotes(blocks), [blocks]);
}

/**
 * Gives `InlineMarkdown` below it the document's notes. Always rendered, so a
 * document gaining its first note keeps its tree; `index` null provides
 * nothing, and references stay text.
 */
export const FootnoteProvider: React.FC<{ index: FootnoteIndex | null; children: React.ReactNode }> = ({ index, children }) => {
  const id = useId();
  const lastRef = useRef<HTMLElement | null>(null);
  const numbers = index?.numbers ?? null;
  const scope = useMemo<FootnoteScope | null>(
    () => (numbers ? { idPrefix: `pn${id.replace(/[^A-Za-z0-9_-]/g, '')}`, numbers, lastRef } : null),
    [id, numbers],
  );
  return <FootnoteContext.Provider value={scope}>{children}</FootnoteContext.Provider>;
};

/** A reference to a defined note: a small superscript number linking to it. */
export const FootnoteRef: React.FC<{ scope: FootnoteScope; label: string; number: number }> = ({ scope, label, number }) => (
  <sup className="pn-footnote-ref">
    <a
      href={`#${noteId(scope, number)}`}
      role="doc-noteref"
      aria-label={`Footnote ${number}`}
      data-footnote-ref={label}
      className="px-px font-medium text-primary no-underline hover:underline focus-visible:underline"
      onClick={(e) => {
        const target = document.getElementById(noteId(scope, number));
        if (!target) return;
        e.preventDefault();
        scope.lastRef.current = e.currentTarget;
        goTo(target);
      }}
    >
      {number}
    </a>
  </sup>
);
