import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { GuideSection } from '@plannotator/core/guide';
import { fileKind, groupByFileKind, type FileKind } from '@plannotator/core/file-kind';
import type { DiffFile } from './types';
import { FILE_KIND_LABELS, FileKindIcon } from './FileKindIcon';
import { renderMarkdownProse } from './renderMarkdownProse';
import type { GuideLinkRenderer } from './renderInlineMarkdown';
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

/** "Tests 2" / "Generated 1" above a kind's chips, shown only when a chapter mixes kinds. */
function KindSubhead({ kind, count }: { kind: FileKind; count: number }) {
  return (
    <div data-guide-kind-subhead={kind} className="flex items-center gap-1.5 px-0.5 pt-1 text-[10.5px] font-medium text-muted-foreground">
      <FileKindIcon kind={kind} />
      <span>{FILE_KIND_LABELS[kind]}</span>
      <span className="tabular-nums text-muted-foreground/60">{count}</span>
    </div>
  );
}

/** The card's own border colour (`border-border/50`): the tab's outline continues it. */
const CARD_BORDER = 'color-mix(in oklab, var(--border) 50%, transparent)';
/** The open card's background (`bg-card`). */
const CARD_FILL = 'var(--card)';
/**
 * The folded card's background (`bg-muted/10`) made opaque over the guide's
 * ground, so the tab's fill hides the card's top border under it.
 */
const FOLDED_CARD_FILL = 'color-mix(in oklab, var(--muted) 10%, var(--background))';
/** Space around the control inside the tab, and the tab's corner radii (the card's rounded-lg). */
const TAB_PAD_X = 6;
const TAB_PAD_Y = 4;
const TAB_RADIUS = 8;
/** The inverse radius where the tab's left side meets the card's top edge. */
const TAB_SHOULDER = 10;

/**
 * A host's control in a small tab rising out of the card's top edge at its
 * top right (GuideHostValue.renderSectionTab): the card's own background and
 * border, only as wide as the control, rounded top corners, and a curved
 * shoulder into the card's top edge. One SVG path draws it: the fill covers
 * the card's top border under the tab, a 1px stroke on half-pixel coordinates
 * continues the card's border, so the outline is one line with no seam. It is
 * part of the card: it scrolls with it.
 */
function SectionTab({ fill, children }: { fill: string; children: React.ReactNode }) {
  const controlRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = controlRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.ceil(el.offsetWidth);
      const h = Math.ceil(el.offsetHeight);
      setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const h = size?.h ?? 0;
  const w = size?.w ?? 0;
  const T = h + TAB_PAD_Y * 2; // the tab's height above the card's top edge
  const s = TAB_SHOULDER;
  const W = s + w + TAB_PAD_X * 2;
  const r = TAB_RADIUS;
  // The card starts right under the row: its top border is the pixel row [T, T+1].
  const xl = s - 0.5;
  const xr = W - 0.5;
  const y0 = 0.5;
  const yb = T + 0.5;
  const outline = `M 0 ${yb} A ${s - 0.5} ${s - 0.5} 0 0 0 ${xl} ${yb - (s - 0.5)} L ${xl} ${y0 + r} A ${r} ${r} 0 0 1 ${xl + r} ${y0} L ${xr - r} ${y0} A ${r} ${r} 0 0 1 ${xr} ${y0 + r} L ${xr} ${T + 1}`;
  return (
    <div data-guide-section-tab="" style={{ position: 'relative', zIndex: 1, height: T, pointerEvents: 'none' }}>
      {size && (
        <svg
          aria-hidden="true"
          width={W}
          height={T + 1}
          viewBox={`0 0 ${W} ${T + 1}`}
          style={{ position: 'absolute', right: 0, top: 0, overflow: 'visible' }}
        >
          <path d={`${outline} L ${W} ${T + 1} L 0 ${T + 1} Z`} style={{ fill }} />
          <path d={outline} style={{ fill: 'none', stroke: CARD_BORDER, strokeWidth: 1 }} />
        </svg>
      )}
      <div
        ref={controlRef}
        style={{ position: 'absolute', right: TAB_PAD_X, top: TAB_PAD_Y, pointerEvents: 'auto', visibility: size ? undefined : 'hidden' }}
      >
        {children}
      </div>
    </div>
  );
}

interface GuideSectionCardProps {
  section: GuideSection;
  files: DiffFile[];
  index: number;
  total: number;
  /** False for the "Everything else" card: it is not one of the guide's sections, so it carries no "NN / NN". */
  numbered?: boolean;
  reviewed?: boolean;
  showReviewed?: boolean;
  onToggleReviewed?: () => void;
  focusedFile: string | null;
  revealTarget: { filePath: string; token: number } | null;
  onActivate: (filePath: string) => void;
  onRequestReveal: (filePath: string) => void;
  /** Renders guide links (`chapter:`, `code:`) in the chapter overview. */
  renderLink?: GuideLinkRenderer;
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
  numbered = true,
  onToggleReviewed,
  focusedFile,
  revealTarget,
  onActivate,
  onRequestReveal,
  renderLink,
}) => {
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null);
  const host = useGuideHost();
  const cardRef = useRef<HTMLDivElement>(null);
  const position = numbered ? `${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}` : null;
  const isCollapsed = showReviewed ? collapsedOverride ?? reviewed : collapsedOverride === true;

  const filesByPath = useMemo(() => new Map(host.files.map((file) => [file.path, file])), [host.files]);
  const summaryByPath = useMemo(() => {
    const summaries = new Map<string, string>();
    for (const ref of section.diffs) {
      if (ref.summary) summaries.set(ref.file, ref.summary);
    }
    return summaries;
  }, [section.diffs]);

  // Within the chapter, files come together by kind (code, tests, generated),
  // keeping the author's order inside each kind. Chips and diff cards share it.
  const chipGroups = useMemo(
    () => groupByFileKind(section.diffs, (ref) => ref.file, host.generatedFiles),
    [section.diffs, host.generatedFiles],
  );
  const orderedFiles = useMemo(
    () => groupByFileKind(files, (file) => file.path, host.generatedFiles).flatMap((group) => group.items),
    [files, host.generatedFiles],
  );
  const showKinds = chipGroups.length > 1;

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

  // A host's control in a tab on this card (the Inbox's diff layout, on the first card); nothing otherwise.
  const tab = host.renderSectionTab?.(index) ?? null;
  // A host's content at the foot of the prose column (VS Code: ask about this chapter); nothing otherwise.
  const footer = host.renderSectionFooter?.(index) ?? null;
  const tabbed = tab !== null && tab !== undefined && tab !== false;
  const withTab = (card: React.ReactNode, fill: string) =>
    tabbed ? (
      <div data-guide-section-tabbed="">
        <SectionTab fill={fill}>{tab}</SectionTab>
        {card}
      </div>
    ) : (
      card
    );
  // Squared under the tab, which carries the corner; a jump to the card keeps the tab in view.
  const tabbedCardStyle: React.CSSProperties | undefined = tabbed ? { borderTopRightRadius: 0, scrollMarginTop: 56 } : undefined;

  if (isCollapsed) {
    return withTab(
      <div ref={cardRef} data-guide-section={index} style={tabbedCardStyle} className="flex w-full items-center gap-3 rounded-lg border border-border/50 bg-muted/10 px-4 py-3">
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
          {position && <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground/40">{position}</span>}
          <ChevronDown className="flex-shrink-0 -rotate-90 text-muted-foreground/40 transition-transform group-hover:text-muted-foreground" size={13} />
        </button>
      </div>,
      FOLDED_CARD_FILL,
    );
  }

  return withTab(
    <div ref={cardRef} data-guide-section={index} style={tabbedCardStyle} className="scroll-mt-4 overflow-clip rounded-lg border border-border/50 bg-card">
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
            {(position || showReviewed) && (
            <div className="mt-2 flex items-center gap-3 md:flex-none">
              {position && <span className="font-mono text-[11px] text-muted-foreground/60">{position}</span>}
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
            )}

            {section.overview && (
              <div className="mt-3.5 space-y-2.5 md:flex-none">{renderMarkdownProse(section.overview, { tone: 'muted', renderLink })}</div>
            )}

            {section.diffs.length > 0 && (
              <div className="mt-5 space-y-1.5 md:min-h-[84px] md:overflow-y-auto md:overflow-x-hidden">
                {chipGroups.map((group) => (
                  <React.Fragment key={group.kind}>
                    {showKinds && group.kind !== 'code' && <KindSubhead kind={group.kind} count={group.items.length} />}
                    {group.items.map((ref) => (
                      <FileChip
                        key={ref.file}
                        filePath={ref.file}
                        summary={ref.summary}
                        file={filesByPath.get(ref.file)}
                        active={focusedFile === ref.file}
                        onClick={() => onRequestReveal(ref.file)}
                      />
                    ))}
                  </React.Fragment>
                ))}
              </div>
            )}
            {footer && <div className="mt-4 md:flex-none">{footer}</div>}
          </div>
        </div>

        <div className="min-w-0 space-y-4 bg-muted/[0.07] px-1.5 py-3 md:px-4 md:py-4">
          {orderedFiles.length > 0 ? (
            orderedFiles.map((file) => (
              <GuideFileCard
                key={file.path}
                file={file}
                summary={summaryByPath.get(file.path)}
                kind={fileKind(file.path, host.generatedFiles)}
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
    </div>,
    CARD_FILL,
  );
};
