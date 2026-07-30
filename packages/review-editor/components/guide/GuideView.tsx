import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeGuideData, GuideSection } from '@plannotator/shared/guide';
import type { DiffFile } from '../../types';
import { useReviewState } from '../../dock/ReviewStateContext';
import { renderInlineMarkdown } from '../../utils/renderInlineMarkdown';
import { GuideSectionCard } from './GuideSectionCard';
import { GuideViewportProvider } from './GuideViewportManager';

interface GuideViewProps {
  guide: CodeGuideData;
  reviewed: boolean[];
  onToggleReviewed: (index: number) => void;
  /** e.g. "Claude" / "Codex" — omitted when the generating job/engine is unknown. */
  engineLabel?: string;
  focusedFile: string | null;
  onFocusFile: (filePath: string) => void;
  /** Launch a fresh guide when a persisted guide no longer matches this branch. */
  onRegenerate?: () => void;
}

export interface ResolvedGuideSections {
  sectionFiles: DiffFile[][];
  unplacedFiles: DiffFile[];
}

/** Resolve guide refs against the current patch while preserving generated
 * order. First placement wins globally; stale refs remain in chapter chips but
 * are omitted from CodeView items. */
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

/**
 * Generated guide with the original vertical chapter/file-card layout. Every
 * lightweight file shell stays in document flow while GuideViewportProvider
 * bounds the mounted one-file Pierre CodeViews across all chapters.
 */
export const GuideView: React.FC<GuideViewProps> = ({
  guide,
  reviewed,
  onToggleReviewed,
  engineLabel,
  focusedFile,
  onFocusFile,
  onRegenerate,
}) => {
  const state = useReviewState();
  const resolved = useMemo(() => resolveGuideSectionFiles(guide, state.files), [guide, state.files]);
  const hasUnplaced = (guide.unplacedFiles?.length ?? 0) > 0;
  const cardTotal = guide.sections.length + (hasUnplaced ? 1 : 0);
  const reviewedCount = reviewed.filter(Boolean).length;
  const effectiveFocusedFile = focusedFile
    ?? resolved.sectionFiles.find((files) => files.length > 0)?.[0]?.path
    ?? resolved.unplacedFiles[0]?.path
    ?? null;

  const localRevealTokenRef = useRef(0);
  const [localRevealTarget, setLocalRevealTarget] = useState<{ filePath: string; token: number } | null>(null);
  const externalRevealTarget = state.guideRevealFile
    ? { filePath: state.guideRevealFile.path, token: state.guideRevealFile.token }
    : null;
  const revealTarget = externalRevealTarget ?? localRevealTarget;

  useEffect(() => {
    if (!revealTarget) return;
    onFocusFile(revealTarget.filePath);
    // Token identifies a navigation event; callback identity must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget?.filePath, revealTarget?.token]);

  const handleRequestReveal = useCallback(
    (filePath: string) => {
      onFocusFile(filePath);
      if (state.onGuideRevealFile) {
        state.onGuideRevealFile(filePath);
      } else {
        localRevealTokenRef.current += 1;
        setLocalRevealTarget({ filePath, token: localRevealTokenRef.current });
      }
    },
    [onFocusFile, state.onGuideRevealFile],
  );

  // Search results are global to the review, but an offscreen guide file has no
  // CodeView to receive the active match. Route each match change through the
  // same reveal channel as outline/sidebar jumps so its chapter opens, its shell
  // mounts, and the target viewer becomes active before line navigation runs.
  const activeSearchMatch = state.allFilesActiveSearchMatch;
  useEffect(() => {
    if (!activeSearchMatch) return;
    handleRequestReveal(activeSearchMatch.filePath);
  }, [activeSearchMatch?.id, activeSearchMatch?.filePath, handleRequestReveal]);

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

  return (
    <GuideViewportProvider className="w-full px-10 py-8">
      <div className="max-w-[72ch]">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground [text-wrap:balance]">{guide.title}</h1>
        {guide.intent && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{renderInlineMarkdown(guide.intent)}</p>
        )}
        <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/60">
          <span>
            {guide.sections.length} section{guide.sections.length !== 1 ? 's' : ''}
            {reviewedCount > 0 && ` · ${reviewedCount}/${guide.sections.length} reviewed`}
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
      </div>

      <div className="mt-6 space-y-4">
        {guide.sections.map((section, index) => (
          <GuideSectionCard
            key={`${section.title}:${index}`}
            section={section}
            files={resolved.sectionFiles[index] ?? []}
            index={index}
            total={cardTotal}
            reviewed={!!reviewed[index]}
            onToggleReviewed={() => onToggleReviewed(index)}
            focusedFile={effectiveFocusedFile}
            revealTarget={revealTarget}
            onActivate={onFocusFile}
            onRequestReveal={handleRequestReveal}
          />
        ))}

        {unplacedSection && (
          <GuideSectionCard
            section={unplacedSection}
            files={resolved.unplacedFiles}
            index={guide.sections.length}
            total={cardTotal}
            showReviewed={false}
            focusedFile={effectiveFocusedFile}
            revealTarget={revealTarget}
            onActivate={onFocusFile}
            onRequestReveal={handleRequestReveal}
          />
        )}
      </div>
    </GuideViewportProvider>
  );
};
