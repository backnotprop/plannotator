import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { GuideSection } from '@plannotator/core/guide';
import type { DiffFile } from './types';
import { renderMarkdownProse } from './renderMarkdownProse';
import { useGuideHost } from './host';
import { GuideFileCard } from './GuideFileCard';

function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-[15px] w-[15px] flex-shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
        checked ? 'border-primary bg-primary' : 'border-border bg-transparent'
      }`}
    >
      {checked && (
        <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6.25L4.75 8.5L9.5 3.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function FileChip({
  filePath,
  summary,
  file,
  active,
  onClick,
}: {
  filePath: string;
  summary?: string;
  file: DiffFile | undefined;
  active: boolean;
  onClick: () => void;
}) {
  const slash = filePath.lastIndexOf('/');
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dir = slash >= 0 ? filePath.slice(0, slash) : '';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors pointer-coarse:py-2.5 ${
        active ? 'border-primary/40 bg-primary/10' : 'border-border/50 bg-background hover:border-border'
      }`}
      title={summary ? `${filePath}\n\n${summary}` : filePath}
    >
      <span className="truncate font-mono text-[11px] font-medium text-foreground">{name}</span>
      {dir && <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/60">{dir}</span>}
      {!file ? (
        <span className="flex-shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50">outdated</span>
      ) : (
        <span className="ml-auto flex-shrink-0 font-mono text-[10px]">
          {file.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>}
          {file.deletions > 0 && <span className="ml-1 text-red-600/80 dark:text-red-400/80">-{file.deletions}</span>}
        </span>
      )}
    </button>
  );
}

interface GuideSectionCardProps {
  section: GuideSection;
  files: DiffFile[];
  index: number;
  total: number;
  reviewed?: boolean;
  showReviewed?: boolean;
  onToggleReviewed?: () => void;
  focusedFile: string | null;
  revealTarget: { filePath: string; token: number } | null;
  onActivate: (filePath: string) => void;
  onRequestReveal: (filePath: string) => void;
}

/**
 * One original Guided Review chapter. Every file keeps its natural description
 * and bounded card in document flow; GuideFileCard decides whether that shell's
 * one-file Pierre CodeView is inside the shared outer mount window.
 */
export const GuideSectionCard: React.FC<GuideSectionCardProps> = ({
  section,
  files,
  index,
  total,
  reviewed = false,
  showReviewed = true,
  onToggleReviewed,
  focusedFile,
  revealTarget,
  onActivate,
  onRequestReveal,
}) => {
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null);
  const host = useGuideHost();
  const cardRef = useRef<HTMLDivElement>(null);
  const position = `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  const isCollapsed = showReviewed ? collapsedOverride ?? reviewed : collapsedOverride === true;

  const filesByPath = useMemo(() => new Map(host.files.map((file) => [file.path, file])), [host.files]);
  const summaryByPath = useMemo(() => {
    const summaries = new Map<string, string>();
    for (const ref of section.diffs) {
      if (ref.summary) summaries.set(ref.file, ref.summary);
    }
    return summaries;
  }, [section.diffs]);

  const targetBelongsHere = revealTarget && section.diffs.some((ref) => ref.file === revealTarget.filePath)
    ? revealTarget
    : null;

  // Reopen a reviewed chapter before its target file shell force-mounts and
  // scrolls itself into view. Reviewed persistence remains unchanged because
  // this is only the local visual override.
  useEffect(() => {
    if (!targetBelongsHere) return;
    setCollapsedOverride(false);
    onActivate(targetBelongsHere.filePath);
    // Token identifies the reveal event; callback identity must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetBelongsHere?.token]);

  const handleToggleReviewed = () => {
    setCollapsedOverride(null);
    onToggleReviewed?.();
  };

  if (isCollapsed) {
    return (
      <div ref={cardRef} className="flex w-full items-center gap-3 rounded-lg border border-border/50 bg-muted/10 px-4 py-3">
        {showReviewed && (
          <button
            type="button"
            onClick={handleToggleReviewed}
            aria-label={reviewed ? 'Un-mark as reviewed' : 'Mark as reviewed'}
            className="flex-shrink-0 rounded relative pointer-coarse:before:absolute pointer-coarse:before:-inset-3.5 pointer-coarse:before:content-['']"
          >
            <Checkbox checked={reviewed} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setCollapsedOverride(false)}
          className="group flex min-w-0 flex-1 items-center gap-3 text-left"
          title="Expand"
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/70">{section.title}</span>
          <span className="flex-shrink-0 text-[11px] text-muted-foreground/60">
            {section.diffs.length} diff{section.diffs.length !== 1 ? 's' : ''}
            {reviewed ? ' · reviewed' : ''}
          </span>
          <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground/40">{position}</span>
          <ChevronDown className="flex-shrink-0 -rotate-90 text-muted-foreground/40 transition-transform group-hover:text-muted-foreground" size={13} />
        </button>
      </div>
    );
  }

  return (
    <div ref={cardRef} className="scroll-mt-4 overflow-clip rounded-lg border border-border/50 bg-card">
      {/* Stacked below md; a proportional chapter column on tablets; the fixed 440px column from lg up (desktop unchanged). */}
      <div className="md:grid md:grid-cols-[minmax(260px,36%)_minmax(0,1fr)] lg:grid-cols-[440px_minmax(0,1fr)]">
        <div className="border-b border-border/40 md:border-b-0 md:border-r">
          <div className="px-4 py-4 md:sticky md:top-0 md:flex md:max-h-[calc(100dvh-48px)] md:flex-col md:overflow-y-auto md:overflow-x-hidden md:px-6 md:py-5">
            <div className="flex items-start gap-2 md:flex-none">
              <h3 className="flex-1 text-[15px] font-semibold leading-snug text-foreground [text-wrap:balance]">
                {section.title}
              </h3>
              <button
                type="button"
                onClick={() => setCollapsedOverride(true)}
                className="mt-0.5 flex-shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-foreground relative pointer-coarse:before:absolute pointer-coarse:before:-inset-3.5 pointer-coarse:before:content-['']"
                title="Collapse section"
                aria-label="Collapse section"
              >
                <ChevronDown className="rotate-180" size={13} />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-3 md:flex-none">
              <span className="font-mono text-[11px] text-muted-foreground/60">{position}</span>
              {showReviewed && (
                <button
                  type="button"
                  onClick={handleToggleReviewed}
                  className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground pointer-coarse:-my-3 pointer-coarse:py-3"
                  title={reviewed ? 'Un-mark as reviewed' : 'Mark as reviewed'}
                >
                  <Checkbox checked={reviewed} />
                  Reviewed
                </button>
              )}
            </div>

            {section.overview && (
              <div className="mt-3.5 space-y-2.5 md:flex-none">{renderMarkdownProse(section.overview, { tone: 'muted' })}</div>
            )}

            {section.diffs.length > 0 && (
              <div className="mt-5 space-y-1.5 md:min-h-[84px] md:overflow-y-auto md:overflow-x-hidden">
                {section.diffs.map((ref) => (
                  <FileChip
                    key={ref.file}
                    filePath={ref.file}
                    summary={ref.summary}
                    file={filesByPath.get(ref.file)}
                    active={focusedFile === ref.file}
                    onClick={() => onRequestReveal(ref.file)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-4 bg-muted/[0.07] px-1.5 py-3 md:px-4 md:py-4">
          {files.length > 0 ? (
            files.map((file) => (
              <GuideFileCard
                key={file.path}
                file={file}
                summary={summaryByPath.get(file.path)}
                focused={focusedFile === file.path}
                revealTarget={targetBelongsHere}
                onActivate={onActivate}
              />
            ))
          ) : (
            <div className="flex min-h-[150px] items-center justify-center px-6 text-center">
              <div>
                <p className="text-xs font-medium text-foreground">No chapter files in the current diff</p>
                <p className="mt-1 text-[11px] text-muted-foreground">The generated references may be out of date.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
