import React from 'react';
import {
  MarkdownEditor as PackagedMarkdownEditor,
  type MarkdownEditorHandle,
} from '@plannotator/markdown-editor';
import type { Extension } from '@codemirror/state';
import '@plannotator/markdown-editor/themes/plannotator.css';
import { useTheme } from './ThemeProvider';

export type { MarkdownEditorHandle };

/*
 * Wiki-links, re-exported through the ui surface. @plannotator/ui is the single supported
 * contract for hosts — do NOT import @plannotator/atomic-editor directly (it's outside the
 * import allowlist).
 */
export { wikiLinks } from '@plannotator/atomic-editor';
export type {
  WikiLinksConfig,
  WikiLinkSuggestion,
  WikiLinkResolvedTarget,
  WikiLinkStatus,
} from '@plannotator/atomic-editor';

export { defaultSlashCommands, slashCommandSource, slashCommands } from '@plannotator/atomic-editor';
export type { SlashCommandItem, SlashCommandsConfig } from '@plannotator/atomic-editor';
export { selectionToolbar } from '@plannotator/atomic-editor';
export type { SelectionToolbarConfig, InlineFormat } from '@plannotator/atomic-editor';

export { linkWidgets, refreshLinkWidgets } from '@plannotator/atomic-editor';
export type { LinkWidgetSpec, LinkWidgetLink } from '@plannotator/atomic-editor';

export { embedPicker, embedSlashItem } from './MarkdownEditor/embedPicker';
export type {
  EmbedKind,
  EmbedPickerConfig,
  EmbedTarget,
} from './MarkdownEditor/embedPicker';
export { planEmbedInsert } from '@plannotator/core/embed-insert';
export type { EmbedInsertPlan } from '@plannotator/core/embed-insert';

const GRID_CARD_CLASSES = 'px-5 md:px-8 lg:px-10 xl:px-12 shadow-xl border border-border/50';

interface MarkdownEditorProps {
  markdown: string;
  documentId: string;
  editorHandleRef: React.MutableRefObject<MarkdownEditorHandle | null>;
  onMarkdownChange?: (markdown: string) => void;
  onLinkClick?: (url: string) => void;
  maxWidth?: number | null;
  gridEnabled?: boolean;
  mode?: React.ComponentProps<typeof PackagedMarkdownEditor>['mode'];
  extensions?: readonly Extension[];
}

/*
 * App.tsx renders its ThemeProvider inside its own JSX, so the resolved color mode must be read
 * from a component beneath the provider — here — and passed down as a prop.
 */
export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({ gridEnabled, mode, ...props }) => {
  const { resolvedMode } = useTheme();
  return (
    <PackagedMarkdownEditor
      {...props}
      mode={mode ?? resolvedMode}
      cardClassName={gridEnabled ? GRID_CARD_CLASSES : undefined}
    />
  );
};
