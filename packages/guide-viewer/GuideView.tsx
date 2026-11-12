import { createPortal } from 'react-dom';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeGuideData, GuideSection } from '@plannotator/core/guide';
import type { DiffFile } from './types';
import { useGuideHost } from './host';
import { parseGuideLink } from '@plannotator/core/guide-links';
import { renderInlineMarkdown, type GuideLinkRenderer } from './renderInlineMarkdown';
import { GuideSectionCard } from './GuideSectionCard';
import { GuideOverview } from './GuideOverview';
import { GUIDE_EAGER_MOUNT_MAX_FILES, GuideViewportProvider } from './GuideViewportManager';
import { GuideGlobalCommentButton, GuideGlobalCommentList } from './GuideGlobalComments';
import { GuideHeading } from './GuideHeading';

interface GuideViewProps {
  guide: CodeGuideData;
  reviewed: boolean[];
  onToggleReviewed: (index: number) => void;
  showReviewed?: boolean;
  engineLabel?: string;
  focusedFile: string | null;
  onFocusFile: (filePath: string) => void;
  onRegenerate?: () => void;
  sourceLine?: React.ReactNode;
  headerActions?: React.ReactNode;
  bare?: boolean;
  actionsHost?: HTMLElement | null;
  threadHeading?: boolean;
  fitFileHeights?: boolean;
}

export interface ResolvedGuideSections {
  sectionFiles: DiffFile[][];
  unplacedFiles: DiffFile[];
}

export function resolveGuideSectionFiles(guide: CodeGuideData, files: DiffFile[]): ResolvedGuideSections {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const sectionFiles = guide.sections.map((section) => {
    const resolved: DiffFile[] = [];
    for (const ref of section.diffs) {
      if (seen.has(ref.file)) continue;
      seen.add(ref.file);
      const file = filesByPath.get(ref.file);
      if (file) resolved.push(file);
    }
    return resolved;
  });

  const unplacedFiles: DiffFile[] = [];
  for (const filePath of guide.unplacedFiles ?? []) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    const file = filesByPath.get(filePath);
    if (file) unplacedFiles.push(file);
  }

  return { sectionFiles, unplacedFiles };
}

export const GuideView: React.FC<GuideViewProps> = ({
  guide,
  reviewed,
  onToggleReviewed,
  showReviewed = true,
  engineLabel,
  focusedFile,
  onFocusFile,
  onRegenerate,
  sourceLine,
  headerActions,
  actionsHost,
  bare = false,
  threadHeading = false,
  fitFileHeights,
}) => {
  const fit = fitFileHeights ?? bare;
  const host = useGuideHost();
  const overviewFigure = host.renderOverviewFigure?.() ?? null;
  const headActions = threadHeading ? (host.renderHeadActions?.() ?? null) : null;
  const addGlobalComment = host.globalComments?.onAdd;
  const resolved = useMemo(() => resolveGuideSectionFiles(guide, host.files), [guide, host.files]);
  const guideFileCount = resolved.sectionFiles.reduce((n, files) => n + files.length, 0) + resolved.unplacedFiles.length;
  const hasUnplaced = (guide.unplacedFiles?.length ?? 0) > 0;
  const cardTotal = guide.sections.length;
  const reviewedCount = reviewed.filter(Boolean).length;
  const effectiveFocusedFile = focusedFile
    ?? resolved.sectionFiles.find((files) => files.length > 0)?.[0]?.path
    ?? resolved.unplacedFiles[0]?.path
    ?? null;

  const localRevealTokenRef = useRef(0);
  const [localRevealTarget, setLocalRevealTarget] = useState<{ filePath: string; token: number } | null>(null);
  const externalRevealTarget = host.revealFile
    ? { filePath: host.revealFile.path, token: host.revealFile.token }
    : null;
  const revealTarget = externalRevealTarget ?? localRevealTarget;

  useEffect(() => {
    if (!revealTarget) return;
    onFocusFile(revealTarget.filePath);
  }, [revealTarget?.filePath, revealTarget?.token]);

  const handleRequestReveal = useCallback(
    (filePath: string) => {
      onFocusFile(filePath);
      if (host.onRevealFile) {
        host.onRevealFile(filePath);
      } else {
        localRevealTokenRef.current += 1;
        setLocalRevealTarget({ filePath, token: localRevealTokenRef.current });
      }
    },
    [onFocusFile, host.onRevealFile],
  );

  const activeSearchMatch = host.activeSearchMatch;
  useEffect(() => {
    if (!activeSearchMatch) return;
    handleRequestReveal(activeSearchMatch.filePath);
  }, [activeSearchMatch?.id, activeSearchMatch?.filePath, handleRequestReveal]);

  const guideFilePaths = useMemo(
    () => new Set([...resolved.sectionFiles.flat(), ...resolved.unplacedFiles].map((file) => file.path)),
    [resolved],
  );
  const viewRef = useRef<HTMLDivElement>(null);
  const jumpToChapter = useCallback(
    (index: number) => {
      const first = resolved.sectionFiles[index]?.[0];
      if (first) {
        handleRequestReveal(first.path);
        return;
      }
      viewRef.current?.querySelector(`[data-guide-section="${index}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    },
    [resolved, handleRequestReveal],
  );
  const renderLink = useCallback<GuideLinkRenderer>(
    (href, label, key) => {
      const parsed = parseGuideLink(href);
      if (!parsed?.ok) return host.renderLink?.(href, label, key) ?? null;
      const link = parsed.link;
      let onClick: (() => void) | null = null;
      if (link.kind === 'chapter' && link.chapter <= guide.sections.length) onClick = () => jumpToChapter(link.chapter - 1);
      if (link.kind === 'code' && guideFilePaths.has(link.path)) onClick = () => handleRequestReveal(link.path);
      if (!onClick) return host.renderLink?.(href, label, key) ?? null;
      return (
        <button
          key={key}
          type="button"
          onClick={onClick}
          data-guide-link={href}
          title={link.kind === 'chapter' ? `Go to chapter ${link.chapter}` : `Go to ${link.kind === 'code' ? link.path : ''}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          {label}
        </button>
      );
    },
    [guide.sections.length, guideFilePaths, jumpToChapter, handleRequestReveal, host.renderLink],
  );

  const unplacedSection = useMemo<GuideSection | null>(
    () =>
      hasUnplaced
        ? {
            title: 'Everything else',
            overview: "Changed files the guide didn't place into a section — shown so nothing is silently left out.",
            diffs: (guide.unplacedFiles ?? []).map((file) => ({ file })),
          }
        : null,
    [guide.unplacedFiles, hasUnplaced],
  );

  const actions = !threadHeading && (headerActions || addGlobalComment) ? (
    <>
      {addGlobalComment && <GuideGlobalCommentButton onAdd={addGlobalComment} />}
      {headerActions}
    </>
  ) : null;
  const firstCardIndex = guide.sections.length > 0 ? 0 : unplacedSection ? guide.sections.length : -1;
  const firstCardTab = bare && firstCardIndex >= 0 ? host.renderSectionTab?.(firstCardIndex, { folded: false, diffs: 1, title: '' }) : null;
  const actionsOnTab = !!actions && !actionsHost && firstCardTab !== null && firstCardTab !== undefined && firstCardTab !== false;

  return (
    <GuideViewportProvider className={threadHeading ? 'gv-guide' : bare ? 'w-full px-4 pt-3.5 pb-6' : 'w-full px-3 py-5 sm:px-6 sm:py-6 lg:px-10 lg:py-8'} eager={guideFileCount <= GUIDE_EAGER_MOUNT_MAX_FILES}>
      {actions && !actionsOnTab && actionsHost && createPortal(actions, actionsHost)}
      {actions && !actionsOnTab && !actionsHost && (
        <div className={bare ? 'mb-3 flex items-center justify-end gap-2' : 'mb-3 flex items-center justify-end gap-2 md:float-right md:mb-0 md:ml-6'}>
          {actions}
        </div>
      )}
      {threadHeading && (
        <GuideHeading
          title={guide.intent}
          facts={[
            ...(engineLabel ? `Written by ${engineLabel}`.split(' · ') : []),
            ...(guide.moved ? ['Generated on a different version of this branch'] : []),
            ...(typeof sourceLine === 'string' ? sourceLine.split(' · ').filter(Boolean) : sourceLine ? [sourceLine] : []),
          ]}
          actions={
            (headActions || headerActions || addGlobalComment) && (
              <>
                {headActions}
                {headerActions}
                {addGlobalComment && <GuideGlobalCommentButton onAdd={addGlobalComment} />}
              </>
            )
          }
        />
      )}
      {!bare && !threadHeading && <div className="max-w-[72ch]">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground [text-wrap:balance]">{guide.title}</h1>
        {guide.intent && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{renderInlineMarkdown(guide.intent)}</p>
        )}
        <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/60">
          <span>
            {guide.sections.length} section{guide.sections.length !== 1 ? 's' : ''}
            {showReviewed && reviewedCount > 0 && ` · ${reviewedCount}/${guide.sections.length} reviewed`}
            {engineLabel && ` · generated by ${engineLabel}`}
          </span>
          {guide.saved && (
            <span
              className="rounded border border-border/50 bg-muted/40 px-1.5 py-px text-[10px] text-muted-foreground"
              title="This guide is persisted and will be available the next time this review opens"
            >
              Saved
            </span>
          )}
        </p>
        {sourceLine && (
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground/60">{sourceLine}</p>
        )}
        {guide.moved && (
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground/50">
            Generated on a different version of this branch
            {onRegenerate && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={onRegenerate}
                  className="underline-offset-2 hover:text-foreground hover:underline"
                >
                  Regenerate
                </button>
              </>
            )}
          </p>
        )}
      </div>}

      {host.globalComments && <GuideGlobalCommentList globalComments={host.globalComments} />}

      {guide.overview && <GuideOverview overview={guide.overview} renderLink={renderLink} plain={threadHeading} />}
      {!guide.overview?.diagram && overviewFigure}

      <div ref={viewRef} className={threadHeading ? 'gv-chapters' : bare ? 'space-y-4' : 'mt-6 space-y-4'}>
        {guide.sections.map((section, index) => (
          <GuideSectionCard
            key={`${section.title}:${index}`}
            section={section}
            files={resolved.sectionFiles[index] ?? []}
            index={index}
            total={cardTotal}
            reviewed={!!reviewed[index]}
            showReviewed={showReviewed}
            onToggleReviewed={() => onToggleReviewed(index)}
            focusedFile={effectiveFocusedFile}
            revealTarget={revealTarget}
            onActivate={onFocusFile}
            onRequestReveal={handleRequestReveal}
            renderLink={renderLink}
            fitFileHeights={fit}
            {...(actionsOnTab && index === 0 ? { tabLead: actions } : {})}
          />
        ))}

        {unplacedSection && (
          <GuideSectionCard
            section={unplacedSection}
            files={resolved.unplacedFiles}
            index={guide.sections.length}
            total={cardTotal}
            showReviewed={false}
            numbered={false}
            focusedFile={effectiveFocusedFile}
            revealTarget={revealTarget}
            onActivate={onFocusFile}
            onRequestReveal={handleRequestReveal}
            fitFileHeights={fit}
            {...(actionsOnTab && firstCardIndex === guide.sections.length ? { tabLead: actions } : {})}
          />
        )}
      </div>
    </GuideViewportProvider>
  );
};
