import React from 'react';
import { __setGraphvizRuntimeLoaderForTests } from '../utils/graphviz';
import { DiagramBlock, type DiagramBlockProps } from './DiagramBlock';

export const __setVizLoaderForTests = __setGraphvizRuntimeLoaderForTests;

export const GraphvizBlock = React.memo(
  (props: DiagramBlockProps) => <DiagramBlock kind="graphviz" {...props} />,
  (prev, next) =>
    prev.block.id === next.block.id &&
    prev.block.content === next.block.content &&
    prev.block.startLine === next.block.startLine &&
    prev.annotations === next.annotations &&
    prev.selectedAnnotationId === next.selectedAnnotationId &&
    prev.onSelectAnnotation === next.onSelectAnnotation &&
    prev.onAddAnnotation === next.onAddAnnotation &&
    prev.readOnly === next.readOnly &&
    prev.onRestoreReport === next.onRestoreReport &&
    prev.reopenComment === next.reopenComment &&
    prev.onComposerAnchor === next.onComposerAnchor,
);
