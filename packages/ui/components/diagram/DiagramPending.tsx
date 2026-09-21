import React from 'react';
import type { DiagramKind } from '@plannotator/core/diagram-anchor';
import type { Block } from '../../types';

/**
 * The diagram fence before there is a diagram: the source under a quiet
 * "Rendering diagram…" status.
 *
 * It lives in its own file, importing nothing but React and two types,
 * because it is the ONE pending state two callers must agree on. The block
 * shows it while the engine chunk and the first render are in flight
 * (`DiagramBlock`'s `renderFallback`), and the document shows it as the
 * Suspense fallback while the diagram block's own chunk loads
 * (`Viewer`) — a chunked host reaches the second one first. Same markup in
 * both places, so a document with a diagram paints the source fence once and
 * never flashes or jumps between the two.
 *
 * Keep it dependency-free: anything imported here lands in the closure of
 * every document read, diagram or not.
 */

/** The fence's own text, as the document would show it unrendered. */
export const DiagramInlineSource: React.FC<{ block: Block; kind: DiagramKind }> = ({ block, kind }) => (
  <pre className="rounded-lg text-[13px] overflow-x-auto bg-muted/50 border border-border/30 p-4">
    <code className={`pn-code font-mono language-${block.language?.trim().split(/\s+/, 1)[0] ?? kind}`}>{block.content}</code>
  </pre>
);

/** The status line plus the source. `data-mermaid-pending` is the hook the
 * Mermaid tests wait on and is kept exactly as it was. */
export const DiagramPending: React.FC<{ block: Block; kind: DiagramKind }> = ({ block, kind }) => (
  <>
    <div
      role="status"
      aria-live="polite"
      data-diagram-pending=""
      {...(kind === 'mermaid' ? { 'data-mermaid-pending': '' } : {})}
      className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/70" aria-hidden="true" />
      Rendering diagram…
    </div>
    <DiagramInlineSource block={block} kind={kind} />
  </>
);

/**
 * The same pending state inside the boxes the block itself renders it in
 * (the block wrapper, the inline host, the viewer's fallback slot), so the
 * Suspense fallback occupies the same space the block will.
 */
export const DiagramBlockPending: React.FC<{ block: Block; kind: DiagramKind }> = ({ block, kind }) => (
  <div className="annotation-exclude my-5 group relative" data-block-id={block.id} data-pinpoint-ignore="" data-diagram-block={kind}>
    <div data-diagram-inline="">
      <div data-diagram-fallback="" className="h-full min-h-0 w-full">
        <DiagramPending block={block} kind={kind} />
      </div>
    </div>
  </div>
);
