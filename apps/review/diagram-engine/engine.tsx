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
