/**
 * A diagram file in the surface (4.4): Plannotator's DiagramViewer full
 * screen, pinch and pan, a tap on a node or an edge hands the part to the
 * shell's comment sheet. Loaded lazily, with the engine behind it.
 */

import { useMemo } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { DiagramViewer, type DiagramHostDraft } from '@plannotator/ui/components/diagram/DiagramViewer';
import type { DiagramComment } from '@plannotator/ui/components/diagram/useDiagramComments';
import { useConfigValue } from '@plannotator/ui/config';
import type { Annotation, Block } from '@plannotator/ui/types';
import { diagramShadowAmount } from '@plannotator/ui/utils/diagramShadow';

export interface SurfaceDiagramProps {
  kind: 'mermaid' | 'graphviz';
  block: Block | undefined;
  annotations: readonly Annotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHostDraft: (draft: DiagramHostDraft | null) => void;
}

export default function SurfaceDiagram({ kind, block, annotations, selectedId, onSelect, onHostDraft }: SurfaceDiagramProps) {
  const { colorTheme, resolvedMode } = useTheme();
  const shadow = useConfigValue('diagramShadow');
  const theme = useMemo(
    () => ({ colorTheme, mode: resolvedMode === 'light' ? ('light' as const) : ('dark' as const), shadowAmount: diagramShadowAmount(shadow) }),
    [colorTheme, resolvedMode, shadow],
  );
  const comments = useMemo<DiagramComment[]>(
    () =>
      annotations
        .filter((a) => a.diagramAnchor != null)
        .map((a) => ({ id: a.id, anchor: a.diagramAnchor!, text: a.text ?? '', author: a.author })),
    [annotations],
  );
  if (!block) return null;
  return (
    <DiagramViewer
      kind={kind}
      source={block.content}
      theme={theme}
      comments={comments}
      onHostDraft={onHostDraft}
      selectedCommentId={selectedId}
      onSelectComment={onSelect}
      renderId={`surface-${kind}`}
      sourceLineOffset={block.diagramSourceLineOffset ?? block.startLine}
      className="h-full"
      canvasClassName="touch-none"
    />
  );
}
