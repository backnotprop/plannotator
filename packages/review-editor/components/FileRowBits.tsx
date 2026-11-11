import React from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';

export { ChangeTypeLetter } from '@plannotator/ui/components/DiffFileTree';
export { ViewedControl, CountColumns, countColumnVars } from '@plannotator/ui/components/FileRowAtoms';

export const StageControl: React.FC<{
  isStaged: boolean;
  isStaging: boolean;
  onStage?: () => void;
}> = ({ isStaged, isStaging, onStage }) => {
  if (isStaged) {
    return (
      <span className="w-4 h-4 flex items-center justify-center flex-shrink-0" title="Staged (git add)" aria-label="Staged">
        <span className="w-1.5 h-1.5 rounded-full bg-primary" />
      </span>
    );
  }
  return (
    <Tooltip content="Stage file (git add)" side="bottom">
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          if (!isStaging) onStage?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            if (!isStaging) onStage?.();
          }
        }}
        className="stage-plus w-4 h-4 flex-shrink-0 rounded border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-muted-foreground/60 hover:bg-muted/50 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary/60"
        aria-label="Stage file"
      >
        {isStaging ? (
          <span className="inline-block w-2 h-2 border border-current border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        )}
      </span>
    </Tooltip>
  );
};

/**
 * Committed-file marker — green dot in the stage-slot column (committed rows can't be staged, so
 * the slot is otherwise empty).
 */
export const CommittedDot: React.FC = () => (
  <span className="w-4 h-4 flex items-center justify-center flex-shrink-0" title="Committed" aria-label="Committed">
    <span className="w-1.5 h-1.5 rounded-full bg-success" />
  </span>
);

export const TruncatedPath: React.FC<{ path: string }> = ({ path }) => {
  const slash = path.lastIndexOf('/');
  if (slash === -1) return <span className="truncate">{path}</span>;
  return (
    <span className="flex items-center min-w-0">
      <span className="truncate">{path.slice(0, slash)}</span>
      <span className="flex-shrink-0 max-w-full truncate">{path.slice(slash)}</span>
    </span>
  );
};

export const AnnotationBadge: React.FC<{ count: number }> = ({ count }) => {
  if (count <= 0) return null;
  return (
    <span className="flex items-center gap-0.5 text-[10px] text-primary flex-shrink-0" title={`${count} annotation${count === 1 ? '' : 's'}`}>
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
      </svg>
      {count}
    </span>
  );
};

export const COMPACT_ROWS_WIDTH = 220;
export const compactRowsProps = (width: number): { 'data-compact-rows'?: '' } =>
  width < COMPACT_ROWS_WIDTH ? { 'data-compact-rows': '' } : {};

export const PanelSectionHeader: React.FC<{
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  ariaLabel?: string;
  tooltip?: string;
}> = ({ label, collapsed, onToggle, icon, children, ariaLabel, tooltip }) => {
  const button = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={ariaLabel}
      data-panel-section-header=""
      data-collapsed={collapsed ? '' : undefined}
      className="panel-section-heading"
    >
      {icon ? (
        <span className="panel-heading-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="panel-heading-label">{label}</span>
      <svg className="panel-heading-chevron" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
      </svg>
      {children}
    </button>
  );
  return tooltip ? (
    <Tooltip content={tooltip} side="right" wide>
      {button}
    </Tooltip>
  ) : (
    button
  );
};
