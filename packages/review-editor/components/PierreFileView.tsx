import React from 'react';
import { File, type LineAnnotation } from '@pierre/diffs/react';
import type { SelectedLineRange as PierreSelectedLineRange } from '@pierre/diffs';
import type { DiffAnnotationMetadata } from '@plannotator/ui/types';

interface PierreFileViewProps {
  filePath: string;
  displayPath?: string;
  contents: string;
  pierreTheme: { type: 'dark' | 'light'; css: string };
  overflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  disableLineNumbers?: boolean;
  disableBackground?: boolean;
  changedLineNumbers?: Set<number>;
  changedLineType?: 'change-addition' | 'change-deletion';
  lineAnnotations: LineAnnotation<DiffAnnotationMetadata>[];
  selectedLines?: PierreSelectedLineRange;
  renderAnnotation: (annotation: LineAnnotation<DiffAnnotationMetadata>) => React.ReactNode;
  renderGutterUtility: (getHoveredLine: () => { lineNumber: number } | undefined) => React.ReactNode;
  onLineSelectionEnd: (range: PierreSelectedLineRange | null) => void;
  onTokenClick?: (props: any, event: MouseEvent) => void;
  onTokenEnter?: (props: any, event: PointerEvent) => void;
  onTokenLeave?: (props: any, event: PointerEvent) => void;
}

function applySingleFileThemeAttrs(
  root: ShadowRoot | HTMLElement,
  {
    diffIndicators,
    disableBackground,
  }: {
    diffIndicators: 'bars' | 'classic' | 'none' | undefined;
    disableBackground: boolean | undefined;
  },
) {
  root.querySelectorAll('[data-file]').forEach((element) => {
    if (!(element instanceof HTMLElement)) return;

    if (disableBackground) element.removeAttribute('data-background');
    else element.setAttribute('data-background', '');

    if (!diffIndicators || diffIndicators === 'none') {
      element.removeAttribute('data-indicators');
    } else {
      element.setAttribute('data-indicators', diffIndicators);
    }
  });
}

function applyChangedLineHighlights(
  root: ShadowRoot | HTMLElement,
  changedLineNumbers: Set<number> | undefined,
  changedLineType: 'change-addition' | 'change-deletion' | undefined,
) {
  root.querySelectorAll('[data-plannotator-single-side-highlight]').forEach((element) => {
    if (element instanceof HTMLElement) {
      element.removeAttribute('data-plannotator-single-side-highlight');
      element.setAttribute('data-line-type', 'context');
    }
  });

  if (!changedLineNumbers?.size || !changedLineType) return;

  for (const lineNumber of changedLineNumbers) {
    root
      .querySelectorAll(`[data-line="${lineNumber}"], [data-column-number="${lineNumber}"]`)
      .forEach((element) => {
        if (element instanceof HTMLElement) {
          element.setAttribute('data-plannotator-single-side-highlight', 'true');
          element.setAttribute('data-line-type', changedLineType);
        }
      });
  }
}

export const PierreFileView: React.FC<PierreFileViewProps> = ({
  filePath,
  displayPath,
  contents,
  pierreTheme,
  overflow,
  diffIndicators,
  disableLineNumbers,
  disableBackground,
  changedLineNumbers,
  changedLineType,
  lineAnnotations,
  selectedLines,
  renderAnnotation,
  renderGutterUtility,
  onLineSelectionEnd,
  onTokenClick,
  onTokenEnter,
  onTokenLeave,
}) => {
  return (
    <File
      file={{ name: displayPath ?? filePath, contents }}
      options={{
        themeType: pierreTheme.type,
        unsafeCSS: pierreTheme.css,
        overflow,
        diffIndicators,
        disableLineNumbers,
        disableBackground,
        disableFileHeader: true,
        enableLineSelection: true,
        enableGutterUtility: true,
        lineHoverHighlight: 'line',
        onLineSelectionEnd,
        onTokenClick,
        onTokenEnter,
        onTokenLeave,
        onPostRender: (node) => {
          const root = node.shadowRoot ?? node;
          if (!(root instanceof ShadowRoot || root instanceof HTMLElement)) return;
          applySingleFileThemeAttrs(root, { diffIndicators, disableBackground });
          applyChangedLineHighlights(root, changedLineNumbers, changedLineType);
        },
      }}
      lineAnnotations={lineAnnotations}
      selectedLines={selectedLines}
      renderAnnotation={renderAnnotation}
      renderGutterUtility={renderGutterUtility}
    />
  );
};
