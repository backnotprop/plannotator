import React from 'react';
import {
  MarkdownDiff as PackagedMarkdownDiff,
  type MarkdownDiffHandle,
  type MarkdownDiffProps as PackagedMarkdownDiffProps,
} from '@plannotator/markdown-editor';
import '@plannotator/markdown-editor/themes/plannotator.css';
import { useTheme } from './ThemeProvider';

export type { MarkdownDiffHandle };

/*
 * Grid-mode card utilities mirror components/MarkdownEditor.tsx exactly, so a host toggling
 * editor <-> diff keeps identical card chrome.
 */
const GRID_CARD_CLASSES = 'px-5 md:px-8 lg:px-10 xl:px-12 shadow-xl border border-border/50';

export interface MarkdownDiffProps
  extends Omit<PackagedMarkdownDiffProps, 'mode' | 'cardClassName'> {
  /** Mirrors MarkdownEditor's grid card chrome so editor <-> diff doesn't jump. */
  gridEnabled?: boolean;
  mode?: PackagedMarkdownDiffProps['mode'];
}

export const MarkdownDiff: React.FC<MarkdownDiffProps> = ({ gridEnabled, mode, ...props }) => {
  const { resolvedMode } = useTheme();
  return (
    <PackagedMarkdownDiff
      {...props}
      mode={mode ?? resolvedMode}
      cardClassName={gridEnabled ? GRID_CARD_CLASSES : undefined}
    />
  );
};
