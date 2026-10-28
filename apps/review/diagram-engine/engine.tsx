/**
 * The code-review diagram engine's entry (see build.ts and
 * packages/review-editor/utils/diagramEngineContract.ts). Never imported by
 * the review page's own graph: the page imports the BUILT file by URL.
 *
 * Read-only: the Markdown preview comments on rendered text, not on diagram
 * parts, so no composer, no comment rail and no Ask AI here.
 */
import React from 'react';
import { MermaidBlock } from '@plannotator/ui/components/MermaidBlock';
import { GraphvizBlock } from '@plannotator/ui/components/GraphvizBlock';
import {
  DIAGRAM_ENGINE_API_VERSION,
  type DiagramFenceProps,
} from '../../../packages/review-editor/utils/diagramEngineContract';

export const apiVersion = DIAGRAM_ENGINE_API_VERSION;

export function DiagramFence({ kind, block }: DiagramFenceProps) {
  return kind === 'mermaid' ? <MermaidBlock block={block} readOnly /> : <GraphvizBlock block={block} readOnly />;
}
