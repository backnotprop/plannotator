import { SemanticFileBadge, type SemanticFileSwitch } from './SemanticFileBadge';
import { COMPACT_FILE_HEADER_HEIGHT } from '../utils/diffChromeMetrics';
import { EllipsisName } from './EllipsisName';
import React, { useRef } from 'react';
import { CallFlowFileBadge } from './CallFlowFileBadge';
import { OpenInAppButton } from '@plannotator/ui/components/OpenInAppButton';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import { useRovingToolbar } from '../hooks/useRovingToolbar';
import { CompactFileActions } from './CompactFileActions';
import type { DiffFileStatus } from '../types';
import { FileKindIcon } from '@plannotator/guide-viewer/FileKindIcon';
import { fileStatusLetter } from '@plannotator/ui/utils/fileStatusLetter';
import { formatCount } from '@plannotator/ui/utils/countFormat';
import { countPatchChanges } from '@plannotator/core/diff-files';

interface FileHeaderProps {
  /** Read-only host: no open-in affordance (it probes the review server). */
  readOnly?: boolean;
  filePath: string;
  patch: string;
  /** Change type — added/deleted/renamed get an icon; modified is undecorated. */
  status?: DiffFileStatus;
  /** Previous path for renames — rendered as "old → new" (diffshub treatment). */
  oldPath?: string;
  isViewed?: boolean;
  onToggleViewed?: () => void;
  /** Chrome preference: false hides the Viewed button (the `V` shortcut and
   *  viewed state are unaffected). */
  showViewedControl?: boolean;
  /** The review app's keys work here: the Viewed tooltip names its key (V). Off where they do not (the Inbox). */
  viewedKeyHint?: boolean;
  isStaged?: boolean;
  isStaging?: boolean;
  onStage?: () => void;
  canStage?: boolean;
  /** Same preference for the Git Add button (the `A` shortcut still works). */
  showStageControl?: boolean;
  stageError?: string | null;
  onFileComment?: (anchorEl: HTMLElement) => void;
  /**
   * Eager registration of the comment button element on mount/unmount (ref
   * callback semantics: element on attach, null on detach). Lets keyboard
   * shortcuts anchor the comment popover without the button ever being
   * clicked. onFileComment alone only surfaces the element on click.
   */
  fileCommentButtonRef?: (el: HTMLButtonElement | null) => void;
  collapseToggle?: React.ReactNode;
  onCollapseToggle?: () => void;
  /** EXPERIMENTAL edit-to-suggestion mode: enter edit mode on this file.
   * Absent = the feature is off and no edit UI renders. */
  onEditFile?: () => void;
  /** This file currently hosts the active edit session. Suppresses the Edit
   * entry button; the session controls live in the EditSessionHud strip the
   * owner renders below this header, never here. */
  isEditing?: boolean;
  /** When set, the Edit button is disabled with this tooltip. */
  editDisabledReason?: string | null;
  /** Compact coarse-pointer treatment. Defaults to the enclosing review state. */
  compactTouchLayout?: boolean;
  /** Marked `linguist-generated` in `.gitattributes` (#1317) — renders a
   * "generated" tag next to the +/- counts. Collapse seeding is the owner's
   * concern; this prop is display-only. */
  isGenerated?: boolean;
  /** A test file (`fileKind` is 'test'): a flask after the name. Display-only. */
  isTest?: boolean;
  /**
   * A Markdown file's view control (Source / Changes / Read), drawn by the
   * caller so read-only hosts (the guides.show viewer) never carry it.
   * `iconOnly` on a tight header; `touch` in the compact touch shell.
   */
  renderMarkdownView?: (fit: { iconOnly: boolean; touch: boolean }) => React.ReactNode;
  /** A host control drawn before the view menu (code review's Changes | Whole file switch). */
  accessory?: React.ReactNode;
  semantic?: SemanticFileSwitch;
  /** A host's own "Open in" (the Inbox's, where a read-only header has none), in the place the app's sits. */
  openIn?: React.ReactNode;
  /**
   * A narrow header keeps the folder, dimmed and cut from its start, before the whole name, so two files of one name
   * read apart (the Inbox's PR page on a phone). Off: a narrow header shows the name alone, as before.
   */
  keepsFolder?: boolean;
  /**
   * The line "Open in" opens the file at, read at the click (openInLineForDiff):
   * the picked lines or comment, else the file's first change.
   */
  openInLine?: () => number | undefined;
}

function splitFilePath(filePath: string): { directory: string; name: string } {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash === -1) {
    return { directory: '', name: filePath };
  }

  return {
    directory: filePath.slice(0, lastSlash + 1),
    name: filePath.slice(lastSlash + 1),
  };
}


const FileStatusLetter: React.FC<{ status: DiffFileStatus; oldPath?: string }> = ({ status, oldPath }) => {
  if (status === 'modified') return null;
  const meta = fileStatusLetter(status, { oldPath });
  return (
    <span className={`flex-none leading-none ${meta.className}`} title={meta.title} aria-label={meta.title} data-file-header-status={meta.letter}>
      {meta.letter}
    </span>
  );
};

/** Sticky file header with file path, Viewed toggle, Git Add, and Copy Diff button */
const TIGHT_LABEL = '@max-[479px]/file-header:hidden';
const TIGHT_PAD = 'gap-1 px-2 py-1 @max-[479px]/file-header:px-1.5';
const ACTIONS_FOLD_WIDTH = 360;
const ACTIONS_FOLD = '@max-[359px]/file-header:hidden';

const FileHeaderView: React.FC<FileHeaderProps> = ({
  filePath,
  patch,
  status,
  oldPath,
  isViewed = false,
  onToggleViewed,
  showViewedControl = true,
  viewedKeyHint = true,
  isStaged = false,
  isStaging = false,
  onStage,
  canStage = false,
  showStageControl = true,
  stageError,
  onFileComment,
  fileCommentButtonRef,
  collapseToggle,
  onCollapseToggle,
  onEditFile,
  isEditing = false,
  editDisabledReason,
  compactTouchLayout,
  readOnly = false,
  isGenerated = false,
  isTest = false,
  renderMarkdownView,
  accessory,
  semantic,
  openIn,
  keepsFolder = false,
  openInLine,
}) => {
  const state = useReviewStateOptional();
  const isCompactTouchLayout = compactTouchLayout ?? state?.isCompactTouchLayout ?? false;
  const headerRef = useRef<HTMLDivElement>(null);
  const fileCommentRef = useRef<HTMLButtonElement>(null);
  useRovingToolbar(headerRef, viewedKeyHint);
  const { directory, name } = splitFilePath(filePath);
  const stageLabel = '';
  const commentLabel = '';
  const headerWidthNow = () => headerRef.current?.clientWidth ?? Infinity;
  const tinyNow = () => !readOnly && headerWidthNow() < ACTIONS_FOLD_WIDTH;
  const actionFold = readOnly ? '' : ACTIONS_FOLD;
  const { additions, deletions } = React.useMemo(() => countPatchChanges(patch), [patch]);

  return (
    <div
      ref={headerRef}
      data-file-header=""
      className={`@container/file-header group/file-header flex-shrink-0 border-b border-border flex items-center justify-between gap-2 transition-colors duration-150 hover:bg-muted/30 ${isCompactTouchLayout ? 'pl-3 pr-1' : 'pl-2 pr-2'}`}
      style={{ height: isCompactTouchLayout ? `${COMPACT_FILE_HEADER_HEIGHT}px` : 'var(--panel-header-h)' }}
      data-file-header-path={filePath}
      role={viewedKeyHint ? 'toolbar' : undefined}
      aria-label={viewedKeyHint ? filePath : undefined}
    >
      <div className="min-w-0 flex flex-1 items-center overflow-hidden" onClick={onCollapseToggle} style={onCollapseToggle ? { cursor: 'pointer' } : undefined}>
        {collapseToggle}
        <span
          className={`min-w-0 flex items-center text-[13px] font-medium leading-normal whitespace-nowrap [font-variant-ligatures:no-contextual] ${isCompactTouchLayout ? 'flex-1' : ''}`}
          title={status === 'renamed' && oldPath ? `${oldPath} → ${filePath}` : filePath}
        >
          {/* Rename: dimmed old path → new path (diffshub treatment). Dropped
              under tight widths — the icon + tooltip still carry it. */}
          {status === 'renamed' && oldPath && !isCompactTouchLayout && (
            <>
              <span className="@max-[559px]/file-header:hidden min-w-0 overflow-hidden text-ellipsis text-muted-foreground/60">
                {oldPath}
              </span>
              <svg
                className="@max-[559px]/file-header:hidden w-3 h-3 mx-1 flex-none text-muted-foreground/60"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </>
          )}
          {isCompactTouchLayout ? (
            /* Match Diffshub's filename treatment: retain the complete path in
             * the accessible DOM and place the ellipsis at the leading edge so
             * the basename/extension receive the available phone width. */
            <span
              data-pn-compact-file-path
              className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-foreground [direction:rtl]"
            >
              <bdi>{filePath}</bdi>
            </span>
          ) : (
            <>
              {directory && (
                <span data-file-header-folder={keepsFolder ? '' : undefined} className={`${keepsFolder ? '' : '@max-[559px]/file-header:hidden '}min-w-0 shrink-[1000] overflow-hidden text-ellipsis whitespace-nowrap font-normal text-muted-foreground [direction:rtl]`}>
                  <bdi>{directory}</bdi>
                </span>
              )}
              <EllipsisName text={name} className="text-foreground" />
            </>
          )}
        </span>
        {isTest && <FileKindIcon kind="test" size={13} className="ml-1.5 flex-none text-muted-foreground" title="Test file" />}
        {(additions > 0 || deletions > 0 || (status && status !== 'modified') || isGenerated) && (
          <span className="min-w-0 shrink-[1000] ml-3 flex h-4 flex-wrap items-center gap-x-1.5 overflow-hidden text-[12px] leading-4 tabular-nums" data-file-header-counts="">
            {additions > 0 && <span className="text-success">+{formatCount(additions)}</span>}
            {deletions > 0 && <span className="text-destructive">−{formatCount(deletions)}</span>}
            {status && <FileStatusLetter status={status} oldPath={oldPath} />}
            {isGenerated && (
              <span
                data-pn-generated-badge
                className="flex-none rounded-sm border border-border/60 bg-muted/60 px-1.5 py-0.5 text-xs font-medium leading-none text-muted-foreground"
                title="Marked linguist-generated in .gitattributes"
              >
                generated
              </span>
            )}
          </span>
        )}
      </div>
      {!isCompactTouchLayout && <div className={`flex flex-shrink-0 items-center pl-2 gap-1`}>
        <CallFlowFileBadge filePath={filePath} oldPath={oldPath} />
        <SemanticFileBadge filePath={filePath} semantic={semantic} />
        {openIn}
        {!readOnly && <OpenInAppButton
          quiet
          extraItems={() => [
            ...(tinyNow() && showStageControl && canStage && onStage ? [{ label: isStaged ? 'Unstage this file' : 'Stage this file', onSelect: onStage }] : []),
            ...(tinyNow() && onFileComment ? [{ label: 'Comment on this file', onSelect: () => headerRef.current && onFileComment(headerRef.current) }] : []),
            ...(tinyNow() && onEditFile && !isEditing && !editDisabledReason ? [{ label: 'Edit to suggest a change', onSelect: onEditFile }] : []),
            ...(state?.onOpenToSide ? [{ label: 'Open to the side', onSelect: () => state.onOpenToSide!(filePath), icon: <OpenToSideIcon /> }] : []),
          ]}
          filePath={filePath}
          base={state?.agentCwd ?? null}
          diffText={patch}
          line={openInLine}
          canOpen={
            state?.canUseLiveWorkspaceActions !== false &&
            !(state?.prMetadata && !state?.agentCwd) &&
            status !== 'deleted'
          }
        />}
        {accessory}
        {renderMarkdownView?.({ iconOnly: false, touch: false })}
        {showViewedControl && onToggleViewed && (
          <button
            onClick={onToggleViewed}
            className={`text-xs rounded transition-colors flex items-center ${TIGHT_PAD} ${
              isViewed
                ? 'text-foreground hover:bg-muted'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={`${isViewed ? 'Mark as not viewed' : 'Mark as viewed'}${viewedKeyHint ? ' (V)' : ''}`}
            aria-pressed={isViewed}
            data-file-header-viewed=""
          >
            {isViewed ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="9" />
              </svg>
            )}
            <span className={TIGHT_LABEL}>Viewed</span>
          </button>
        )}
        {showStageControl && canStage && onStage && (
          <button
            onClick={onStage}
            disabled={isStaging}
            className={`${actionFold} text-xs rounded transition-colors flex items-center ${stageLabel ? 'gap-1 px-2 py-1' : 'px-1.5 py-1'} ${
              isStaging
                ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                : isStaged
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={isStaged ? "Unstage this file (A)" : "Stage this file (A)"}
            aria-label={isStaged ? "Unstage this file" : "Stage this file"}
          >
            {isStaging ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : isStaged ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            )}
            {stageLabel && <span>{stageLabel}</span>}
          </button>
        )}
        {stageError && (
          <span className="max-w-24 truncate text-xs text-destructive" title={stageError}>
            {stageError}
          </span>
        )}
        {onFileComment && (
          <button
            ref={(el) => {
              fileCommentRef.current = el;
              fileCommentButtonRef?.(el);
            }}
            onClick={() => fileCommentRef.current && onFileComment(fileCommentRef.current)}
            className={`${actionFold} text-xs rounded transition-colors flex items-center text-muted-foreground hover:text-foreground hover:bg-muted ${commentLabel ? 'gap-1 px-2 py-1' : 'px-1.5 py-1'}`}
            title="Add file-scoped comment"
            aria-label="Comment on this file"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-4l-4 4v-4z" />
            </svg>
            {commentLabel && <span>{commentLabel}</span>}
          </button>
        )}
        {/* Edit entry lives at the far right of the row, next to the file
            actions dropdown, so the experimental affordance stays out of the
            everyday Viewed/Add/Comment cluster. */}
        {onEditFile && !isEditing && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!editDisabledReason) onEditFile();
            }}
            disabled={!!editDisabledReason}
            className={`${actionFold} text-xs rounded transition-colors flex items-center ${TIGHT_PAD} ${
              editDisabledReason
                ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={editDisabledReason ?? 'Edit this file to author a suggestion (experimental)'}
            data-testid="edit-session-start"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            <span className={TIGHT_LABEL}>Edit</span>
          </button>
        )}
      </div>}
      {isCompactTouchLayout && semantic && <SemanticFileBadge filePath={filePath} semantic={semantic} touch />}
      {isCompactTouchLayout && readOnly && renderMarkdownView?.({ iconOnly: false, touch: true })}
      {isCompactTouchLayout && !readOnly && (
        <CompactFileActions
          filePath={filePath}
          patch={patch}
          line={openInLine}
          canOpen={state?.canUseLiveWorkspaceActions !== false && !(state?.prMetadata && !state?.agentCwd) && status !== 'deleted'}
          base={state?.agentCwd ?? null}
          markdownView={renderMarkdownView?.({ iconOnly: true, touch: isCompactTouchLayout })}
          viewSwitch={accessory}
          viewed={showViewedControl && onToggleViewed ? { isViewed, onToggle: onToggleViewed } : null}
          onComment={onFileComment ? () => headerRef.current && onFileComment(headerRef.current) : undefined}
          stage={showStageControl && canStage && onStage ? { isStaged, isStaging, onStage } : null}
          onEdit={onEditFile && !isEditing && !editDisabledReason ? onEditFile : undefined}
        />
      )}
    </div>
  );
};

const OpenToSideIcon: React.FC = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </svg>
);

export const FileHeader = React.memo(FileHeaderView);
