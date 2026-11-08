/**
 * A guide overview's Mermaid diagram in the Inbox (the guided review, the
 * walkthrough and the pull request page all draw guides through GuideReader):
 * drawn read-only by Plannotator's own Mermaid block, the one a message's
 * ```mermaid fence uses, so it follows the window's palette and mode and has
 * the same Show source and Expand. The block is a lazy chunk, the same one the
 * message Viewer loads, and the Mermaid runtime behind it loads on the first
 * diagram: a guide without one never fetches either.
 *
 * Until it is drawn the source shows under "Rendering diagram…"; a source
 * that does not render stays as its plain fence (`sourceOnError`), never the
 * error panel, since the person did not write it. An HTML picture is left to
 * the host's own renderer and then to the guide chain's note.
 */

import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import { DiagramBlockPending } from '@plannotator/ui/components/diagram/DiagramPending';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import type { Block } from '@plannotator/ui/types';

const MermaidBlock = lazy(async () => ({ default: (await import('@plannotator/ui/components/MermaidBlock')).MermaidBlock }));

export function OverviewMermaid({ source }: { source: string }) {
  const block = useMemo<Block>(
    () => ({ id: 'guide-overview-diagram', type: 'code', language: 'mermaid', content: source, order: 0, startLine: 1 }),
    [source],
  );
  return (
    <LazyBlockBoundary fallback={(notice) => <DiagramBlockPending block={block} kind="mermaid" notice={notice} />}>
      <Suspense fallback={<DiagramBlockPending block={block} kind="mermaid" />}>
        <MermaidBlock block={block} readOnly sourceOnError />
      </Suspense>
    </LazyBlockBoundary>
  );
}

/** The host's renderer first (code review's HTML picture); a Mermaid diagram it leaves is drawn here. */
export function withOverviewMermaid(
  host: ((diagram: GuideOverviewDiagram) => ReactNode | null) | undefined,
): (diagram: GuideOverviewDiagram) => ReactNode | null {
  return (diagram) => host?.(diagram) ?? (diagram.kind === 'mermaid' ? <OverviewMermaid source={diagram.source} /> : null);
}
