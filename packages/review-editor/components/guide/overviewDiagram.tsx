import React from 'react';
import { ReviewDiagramFence } from '../ReviewDiagramFence';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import type { Block } from '@plannotator/ui/types';
import type { DiagramEngineUrls } from '../../utils/diagramEngineContract';

/** The guide overview's Mermaid diagram, drawn by the diagram engine the
 * review server serves on demand (guides.show draws it with its own lazily
 * loaded engine). Without the engine, or for an HTML picture, null: the guide
 * chain shows the source or its note. */
export function overviewDiagramRenderer(urls: DiagramEngineUrls | null | undefined) {
  if (!urls) return undefined;
  return (diagram: GuideOverviewDiagram): React.ReactNode | null => {
    if (diagram.kind !== 'mermaid') return null;
    const block: Block = { id: 'guide-overview-diagram', type: 'code', language: 'mermaid', content: diagram.source, order: 0, startLine: 1 };
    // The same source block the guide chain shows without an engine.
    const source = (
      <pre className="overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-3 font-mono text-[11px] text-muted-foreground">
        <code>{diagram.source}</code>
      </pre>
    );
    return <ReviewDiagramFence block={block} kind="mermaid" urls={urls} fallback={source} />;
  };
}
