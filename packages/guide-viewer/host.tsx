import React, { createContext, useContext } from 'react';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import type { DiffFile } from './types';

/**
 * The guide chain (GuideView → GuideSectionCard → GuideFileCard) is rendered by
 * two hosts: the Plannotator review app and the portable guide viewer. Both
 * supply the same narrow contract through this context instead of the app's
 * ~200-field ReviewState, which is what lets the chain live in a package
 * without a server, a dock, or annotations behind it.
 *
 * Decision record: adr/decisions/007-portable-guided-reviews-20260815.md (D2).
 */

/** A "reveal this file" navigation event. `token` bumps per event so re-revealing the same path re-fires. */
export interface GuideRevealTarget {
  path: string;
  token: number;
}

/** The host's active global-search match, if it has a search. */
export interface GuideActiveSearchMatch {
  id: string;
  filePath: string;
}

/**
 * The minimum a diff renderer must accept from the guide chain. In Plannotator
 * this is `AllFilesCodeView`; the props below are exactly the guide-specific
 * subset added for the virtualized guide (#1158): one file per instance, a
 * tokenized scroll target, and remount-continuity for the viewport window.
 */
export interface GuideDiffRendererProps {
  files: DiffFile[];
  fileScrollTarget: { filePath: string; token: number } | null;
  fileOrder: 'list';
  mountCollapsed: boolean;
  initialScrollPosition: number;
  onScrollPositionChange: (position: number) => void;
  onFileCollapsedChange: (filePath: string, collapsed: boolean) => void;
  /** The focused card is the keyboard/annotation target. */
  isActive: boolean;
  allowScrollChaining: true;
}

export interface GuideDiffRendererContext {
  file: DiffFile;
  focused: boolean;
}

export interface GuideHostValue<P extends object = Record<string, unknown>> {
  /** Every file of the review the guide describes. Guide refs resolve against this list. */
  files: DiffFile[];
  /** Renders one file's diff. */
  DiffRenderer: React.ComponentType<GuideDiffRendererProps & P>;
  /**
   * Extra props forwarded to every DiffRenderer instance (annotation, staging,
   * search and AI wiring in-app; nothing in a read-only host). Called per card
   * so per-card values (e.g. a pending selection only for the focused file) can
   * be expressed without leaking focus state into the host.
   */
  getDiffRendererProps: (context: GuideDiffRendererContext) => P;
  /** Host-owned reveal channel (sidebar/outline jumps). Optional — the chain falls back to a local channel. */
  revealFile?: GuideRevealTarget | null;
  onRevealFile?: (path: string) => void;
  /** Host-owned global search: the active match is routed to its chapter so an offscreen file mounts first. */
  activeSearchMatch?: GuideActiveSearchMatch | null;
  /**
   * Paths the host knows are generated (the review server's `generatedFiles`).
   * Optional: without it the built-in name list decides (lockfiles, minified
   * files, source maps). Used only to sort a chapter's files by kind.
   */
  generatedFiles?: ReadonlySet<string>;
  /**
   * Draws the guide overview's diagram (format version 2). The guide chain
   * never imports a diagram engine itself (the review app's bundle must not
   * carry one; tests/entry-assets.test.ts), so a host that can draw Mermaid
   * passes it here. Absent, or answering null: the diagram's source is shown
   * as text (Mermaid) or a note says the viewer does not draw it (HTML).
   */
  renderOverviewDiagram?: (diagram: GuideOverviewDiagram) => React.ReactNode | null;
  /**
   * A control the host raises in a small tab out of a section card's top-right
   * edge (the Inbox: its Split | Unified switch on the first card). Called with
   * each card's index (the "Everything else" card's is the number of
   * sections); answering null (or absent) leaves that card exactly as it is.
   * The card draws the tab in its own background and border, only as wide as
   * the control; the host draws only the control. The tab assumes the guide
   * sits on `--background`, as it does in every host.
   */
  renderSectionTab?: (index: number) => React.ReactNode | null;
  /**
   * Controls a host draws on a file card's summary row, at its right (the VS
   * Code extension: Open in editor, Diff). Answering null (or absent) leaves
   * the card exactly as it is.
   */
  renderFileActions?: (file: DiffFile) => React.ReactNode | null;
  /**
   * Content a host adds at the foot of a section card's prose column, under
   * its file chips (the VS Code extension: ask the agent about this chapter,
   * and the chapter's answers). Called with the card's index; answering null
   * (or absent) leaves the card exactly as it is.
   */
  renderSectionFooter?: (index: number) => React.ReactNode | null;
  /**
   * Draws a guide link the chain cannot follow itself (a `symbol:` link, a
   * `code:` link to a file outside the guide): the VS Code extension asks
   * the language server. Answering null (or absent) shows the link's label
   * as plain text, as before.
   */
  renderLink?: (href: string, label: React.ReactNode, key: string | number) => React.ReactNode | null;
}

// The context erases the renderer's extra-prop generic; hosts recover typing at the provider site.
const GuideHostContext = createContext<GuideHostValue<any> | null>(null);

export function GuideHostProvider<P extends object>({
  value,
  children,
}: {
  value: GuideHostValue<P>;
  children: React.ReactNode;
}) {
  return <GuideHostContext.Provider value={value}>{children}</GuideHostContext.Provider>;
}

/** Throws when no host is mounted — rendering the guide chain without one is always a wiring bug. */
export function useGuideHost(): GuideHostValue<Record<string, unknown>> {
  const value = useContext(GuideHostContext);
  if (!value) throw new Error('GuideHostProvider is missing above the guide chain');
  return value;
}
