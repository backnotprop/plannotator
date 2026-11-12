import React from 'react';
import { MermaidBlock } from '@plannotator/ui/components/MermaidBlock';
import type { Block } from '@plannotator/ui/types';

export default function OverviewDiagram({ source, id = 'guide-overview-diagram' }: { source: string; id?: string }) {
  const block = React.useMemo<Block>(
    () => ({ id, type: 'code', language: 'mermaid', content: source, order: 0, startLine: 1 }),
    [id, source],
  );
  return <MermaidBlock block={block} readOnly />;
}
