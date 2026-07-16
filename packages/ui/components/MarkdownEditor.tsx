import React from 'react';
import {
  MarkdownEditor as PackagedMarkdownEditor,
  type MarkdownEditorHandle,
} from '@plannotator/markdown-editor';
import type { Extension } from '@codemirror/state';
import '@plannotator/markdown-editor/themes/plannotator.css';
import { useTheme } from './ThemeProvider';

export type { MarkdownEditorHandle };

/* Wiki-links, re-exported through the ui surface. @plannotator/ui is the single
   supported contract for hosts — do NOT import @plannotator/atomic-editor
   directly (it's outside the import allowlist). Build the extension with
   wikiLinks(config) and pass it through the `extensions` prop below; the
   capture-once-per-documentId caveat on `extensions` applies (config callbacks
   like suggest/resolve/onOpen may close over live state). */
export { wikiLinks } from '@plannotator/atomic-editor';
export type {
  WikiLinksConfig,
  WikiLinkSuggestion,
  WikiLinkResolvedTarget,
  WikiLinkStatus,
} from '@plannotator/atomic-editor';

/* The engine's other opt-in UI extensions, re-exported for the same reason:
   slashCommands() is a Notion-style insert menu on `/` at the start of a
   line; selectionToolbar() is a floating bold/italic/strike/code/link bar
   over selected text (multi-line and table-cell aware). Both compose
   through the `extensions` prop and theme via the --atomic-editor-menu-*
   CSS variables. */
export { defaultSlashCommands, slashCommandSource, slashCommands } from '@plannotator/atomic-editor';
export type { SlashCommandItem, SlashCommandsConfig } from '@plannotator/atomic-editor';
export { selectionToolbar } from '@plannotator/atomic-editor';
export type { SelectionToolbarConfig, InlineFormat } from '@plannotator/atomic-editor';

/* Grid-mode card utilities stay here (not in the package): they're Plannotator
   design-system Tailwind classes, and this file is @source-scanned. */
const GRID_CARD_CLASSES = 'px-5 md:px-8 lg:px-10 xl:px-12 shadow-xl border border-border/50';

interface MarkdownEditorProps {
  /** Initial markdown. Read at mount only — the editor owns the text after that.
      Read the current text via editorHandleRef.current.getMarkdown(). */
  markdown: string;
  /** Identity key; change to remount with new content. */
  documentId: string;
  editorHandleRef: React.MutableRefObject<MarkdownEditorHandle | null>;
  onMarkdownChange?: (markdown: string) => void;
  onLinkClick?: (url: string) => void;
  /** Mirrors the Viewer card's outer maxWidth so toggling view<->edit doesn't jump. */
  maxWidth?: number | null;
  gridEnabled?: boolean;
  /** Theme color mode. Defaults to the ThemeProvider's resolved mode (Plannotator
      passes nothing); a host without ThemeProvider can supply it directly. */
  mode?: React.ComponentProps<typeof PackagedMarkdownEditor>['mode'];
  /**
   * Extra CodeMirror 6 extensions, forwarded verbatim to the underlying editor
   * (e.g. `wikiLinks(config)`, collaboration bindings like y-codemirror.next).
   * They are appended after the editor's built-ins, so they compose on top —
   * use `Prec.high` from `@codemirror/state` when an extension must beat a
   * built-in keymap. Build them against YOUR copy of the `@codemirror/*`
   * packages; two live copies of `@codemirror/state` break the editor.
   *
   * ⚠️ CAPTURED ONCE PER `documentId` — NOT reactive. The engine reads this
   * array a single time, when it mounts the document (keyed on `documentId`).
   * Swapping in a different array afterwards does NOT re-apply it: the change
   * is silently ignored until the next remount (i.e. a `documentId` change).
   * Therefore:
   *   - pass a stable reference (module constant, or `useMemo` keyed on
   *     `documentId`), and
   *   - never encode changing data in the array itself. Extension config
   *     callbacks MAY close over live state (refs/getters) — that is the
   *     supported way to feed dynamic data into a mounted editor.
   */
  extensions?: readonly Extension[];
}

/* Theme-bridging shim around @plannotator/markdown-editor. App.tsx renders its
   ThemeProvider inside its own JSX, so the resolved color mode must be read
   from a component beneath the provider — here — and passed down as a prop. */
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
