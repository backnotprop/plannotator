import React from 'react';
import { MERMAID_CONFIG, __setMermaidRuntimeLoaderForTests } from '../utils/mermaid';
import { DiagramBlock, type DiagramBlockProps } from './DiagramBlock';

// Compatibility exports for existing integrations and tests; rendering itself always goes through Pele.
export { MERMAID_CONFIG, __setMermaidRuntimeLoaderForTests };

/** A Mermaid-syntax fence; Pele handles rendering through DiagramBlock. */
export const MermaidBlock = React.memo(
  (props: DiagramBlockProps) => <DiagramBlock kind="mermaid" {...props} />,
  (prev, next) =>
    prev.block.id === next.block.id &&
    prev.block.content === next.block.content &&
    prev.block.startLine === next.block.startLine &&
    prev.annotations === next.annotations &&
    prev.selectedAnnotationId === next.selectedAnnotationId &&
    prev.onSelectAnnotation === next.onSelectAnnotation &&
    prev.onAddAnnotation === next.onAddAnnotation &&
    prev.readOnly === next.readOnly &&
    prev.onRestoreReport === next.onRestoreReport,
);
