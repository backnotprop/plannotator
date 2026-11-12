import React from 'react';
import type { DiagramKind } from '@plannotator/core/diagram-anchor';
import type { Block } from '../../types';

export const DiagramInlineSource: React.FC<{ block: Block; kind: DiagramKind }> = ({ block, kind }) => (
  <pre className="rounded-lg text-[13px] overflow-x-auto bg-muted/50 border border-border/30 p-4">
    <code className={`pn-code font-mono language-${block.language?.trim().split(/\s+/, 1)[0] ?? kind}`}>{block.content}</code>
  </pre>
);

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

export const DiagramBlockPending: React.FC<{ block: Block; kind: DiagramKind; notice?: React.ReactNode }> = ({ block, kind, notice }) => (
  <div className="annotation-exclude my-5 group relative" data-block-id={block.id} data-pinpoint-ignore="" data-diagram-block={kind}>
    <div data-diagram-inline="">
      <div data-diagram-fallback="" className="h-full min-h-0 w-full">
        {notice === undefined ? (
          <DiagramPending block={block} kind={kind} />
        ) : (
          <>
            {notice}
            <DiagramInlineSource block={block} kind={kind} />
          </>
        )}
      </div>
    </div>
  </div>
);
