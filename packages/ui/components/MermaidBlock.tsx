import React from 'react';
import { MERMAID_CONFIG, __setMermaidRuntimeLoaderForTests } from '../utils/mermaid';
import { DiagramBlock, type DiagramBlockProps } from './DiagramBlock';

// Re-exported: the config pin test and the lazy-retry test import them from here.
export { MERMAID_CONFIG, __setMermaidRuntimeLoaderForTests };

/**
 * A mermaid fence. The engine, the canvas, the comment overlay and the
 * popout are `DiagramBlock`'s (one code path with `GraphvizBlock`); this
 * file keeps the fence's name and the test hooks. The runtime comes from the
 * slot in `utils/mermaid`: loaded lazily on the first diagram, or already
 * filled by a host that imported `utils/mermaid-eager`.
 */
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
