import React, { createContext, useContext } from 'react';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import type { DiffFile } from './types';

export interface GuideRevealTarget {
  path: string;
  token: number;
}

export interface GuideActiveSearchMatch {
  id: string;
  filePath: string;
}

export interface GuideDiffRendererProps {
  files: DiffFile[];
  fileScrollTarget: { filePath: string; token: number } | null;
  fileOrder: 'list';
  mountCollapsed: boolean;
  initialScrollPosition: number;
  onScrollPositionChange: (position: number) => void;
  onFileCollapsedChange: (filePath: string, collapsed: boolean) => void;
  isActive: boolean;
  allowScrollChaining: true;
  onContentHeightChange?: (height: number) => void;
  scrollsWithPage?: boolean;
}

export interface GuideDiffRendererContext {
  file: DiffFile;
  focused: boolean;
}

export interface GuideGlobalComment {
  id: string;
  text: string;
}

export interface GuideGlobalComments {
  comments: readonly GuideGlobalComment[];
  onAdd?: (anchor: HTMLElement) => void;
  onSelect?: (id: string) => void;
  selectedId?: string | null;
}

export interface GuideHostValue<P extends object = Record<string, unknown>> {
  files: DiffFile[];
  DiffRenderer: React.ComponentType<GuideDiffRendererProps & P>;
  getDiffRendererProps: (context: GuideDiffRendererContext) => P;
  revealFile?: GuideRevealTarget | null;
  onRevealFile?: (path: string) => void;
  activeSearchMatch?: GuideActiveSearchMatch | null;
  generatedFiles?: ReadonlySet<string>;
  renderOverviewDiagram?: (diagram: GuideOverviewDiagram) => React.ReactNode | null;
  renderChapterDiagram?: (diagram: GuideOverviewDiagram, index: number) => React.ReactNode | null;
  diagramFoldStore?: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
  chapterDiagramsFolded?: boolean;
  renderOverviewFigure?: () => React.ReactNode | null;
  renderHeadActions?: () => React.ReactNode | null;
  renderSectionTab?: (index: number, card: { folded: boolean; diffs: number; title: string }) => React.ReactNode | null;
  renderFileActions?: (file: DiffFile) => React.ReactNode | null;
  renderSectionFooter?: (index: number) => React.ReactNode | null;
  renderSectionEmpty?: (index: number) => React.ReactNode | null;
  renderLink?: (href: string, label: React.ReactNode, key: string | number) => React.ReactNode | null;
  globalComments?: GuideGlobalComments;
  diffStyle?: 'split' | 'unified';
  opensWholeFiles?: boolean;
  flushFiles?: boolean;
  collapseAll?: { collapsed: boolean; token: number };
}

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

export function useGuideHost(): GuideHostValue<Record<string, unknown>> {
  const value = useContext(GuideHostContext);
  if (!value) throw new Error('GuideHostProvider is missing above the guide chain');
  return value;
}
