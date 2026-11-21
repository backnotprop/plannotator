/**
 * The guide overview's (format version 2) or a chapter's (version 5) Mermaid diagram, drawn by
 * Plannotator's diagram engine, read-only. Loaded only through main.tsx's
 * lazy import, so the engine (MermaidBlock → DiagramBlock → the Mermaid
 * runtime, itself loaded lazily by utils/mermaid) stays out of the viewer
 * entry and its budget: a guide without a diagram never downloads it.
 * The engine sanitizes the rendered SVG (no script, no handlers, no link
 * targets), so a `click` line in the agent's source is inert here.
 */
import React from 'react';
import { MermaidBlock } from '@plannotator/ui/components/MermaidBlock';
import type { Block } from '@plannotator/ui/types';

export default function OverviewDiagram({ source, id = 'guide-overview-diagram' }: { source: string; /** Unique on the page (a chapter's: one per chapter). */ id?: string }) {
  const block = React.useMemo<Block>(
    () => ({ id, type: 'code', language: 'mermaid', content: source, order: 0, startLine: 1 }),
    [id, source],
  );
  return <MermaidBlock block={block} readOnly />;
}
