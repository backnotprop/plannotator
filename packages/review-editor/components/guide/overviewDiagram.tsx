import React from 'react';
import { ReviewDiagramFence } from '../ReviewDiagramFence';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import type { Block } from '@plannotator/ui/types';
import type { DiagramEngineUrls } from '../../utils/diagramEngineContract';

export function overviewDiagramRenderer(urls: DiagramEngineUrls | null | undefined) {
  if (!urls) return undefined;
  return (diagram: GuideOverviewDiagram): React.ReactNode | null => drawMermaid(diagram, 'guide-overview-diagram', urls);
}

export function chapterDiagramRenderer(urls: DiagramEngineUrls | null | undefined) {
  if (!urls) return undefined;
  return (diagram: GuideOverviewDiagram, index: number): React.ReactNode | null => drawMermaid(diagram, `guide-chapter-${index + 1}-diagram`, urls);
}

function drawMermaid(diagram: GuideOverviewDiagram, id: string, urls: DiagramEngineUrls): React.ReactNode | null {
  if (diagram.kind !== 'mermaid') return null;
  const block: Block = { id, type: 'code', language: 'mermaid', content: diagram.source, order: 0, startLine: 1 };
  const source = (
    <pre className="overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-3 font-mono text-[11px] text-muted-foreground">
      <code>{diagram.source}</code>
    </pre>
  );
  return <ReviewDiagramFence block={block} kind="mermaid" urls={urls} fallback={source} />;
}
