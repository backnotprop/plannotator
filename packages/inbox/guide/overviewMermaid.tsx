import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import { DiagramBlockPending } from '@plannotator/ui/components/diagram/DiagramPending';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import type { Block } from '@plannotator/ui/types';

const MermaidBlock = lazy(async () => ({ default: (await import('@plannotator/ui/components/MermaidBlock')).MermaidBlock }));

export function OverviewMermaid({ source, id = 'guide-overview-diagram' }: { source: string; id?: string }) {
  const block = useMemo<Block>(
    () => ({ id, type: 'code', language: 'mermaid', content: source, order: 0, startLine: 1 }),
    [id, source],
  );
  return (
    <LazyBlockBoundary fallback={(notice) => <DiagramBlockPending block={block} kind="mermaid" notice={notice} />}>
      <Suspense fallback={<DiagramBlockPending block={block} kind="mermaid" />}>
        <MermaidBlock block={block} readOnly sourceOnError />
      </Suspense>
    </LazyBlockBoundary>
  );
}

export function withOverviewMermaid(
  host: ((diagram: GuideOverviewDiagram) => ReactNode | null) | undefined,
): (diagram: GuideOverviewDiagram) => ReactNode | null {
  return (diagram) => host?.(diagram) ?? (diagram.kind === 'mermaid' ? <OverviewMermaid source={diagram.source} /> : null);
}

export function withChapterMermaid(
  host: ((diagram: GuideOverviewDiagram, index: number) => ReactNode | null) | undefined,
): (diagram: GuideOverviewDiagram, index: number) => ReactNode | null {
  return (diagram, index) =>
    host?.(diagram, index) ?? (diagram.kind === 'mermaid' ? <OverviewMermaid source={diagram.source} id={`guide-chapter-${index + 1}-diagram`} /> : null);
}
