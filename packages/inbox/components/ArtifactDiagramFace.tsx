import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DiagramKind } from '@plannotator/core/diagram-anchor';
import { useConfigValue } from '@plannotator/ui/config';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { renderDiagram, type DiagramTheme } from '@plannotator/ui/utils/diagram-render';
import { diagramShadowAmount } from '@plannotator/ui/utils/diagramShadow';

export function ArtifactDiagramFace({ kind, source, fallback }: { kind: DiagramKind; source: string; fallback: React.ReactNode }) {
  const { colorTheme, resolvedMode } = useTheme();
  const diagramShadow = useConfigValue('diagramShadow');
  const theme = useMemo<DiagramTheme>(
    () => ({ colorTheme, mode: resolvedMode === 'light' ? 'light' : 'dark', shadowAmount: diagramShadowAmount(diagramShadow) }),
    [colorTheme, resolvedMode, diagramShadow],
  );
  const renderId = `ib-art-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const holder = useRef<HTMLSpanElement>(null);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void renderDiagram(kind, renderId, source, theme)
      .then((result) => {
        const el = holder.current;
        if (cancelled || !el || !result.ok) return;
        const svg = result.svgNode;
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.style.maxWidth = '';
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        el.replaceChildren(svg);
        setDrawn(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kind, renderId, source, theme]);
  return (
    <>
      <span ref={holder} className="ib-art-svg" aria-hidden="true" data-drawn={drawn ? '' : undefined} />
      {!drawn && fallback}
    </>
  );
}
