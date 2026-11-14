import React from 'react';
import { GitBranchPlus, MessageSquare, PencilLine } from 'lucide-react';
import { OpenInAppButton } from '@plannotator/ui/components/OpenInAppButton';

interface CompactFileActionsProps {
  filePath: string;
  patch: string;
  canOpen: boolean;
  base: string | null;
  markdownView?: React.ReactNode;
  viewSwitch?: React.ReactNode;
  viewed: { isViewed: boolean; onToggle: () => void } | null;
  onComment?: () => void;
  stage: { isStaged: boolean; isStaging: boolean; onStage: () => void } | null;
  onEdit?: () => void;
}

const ICON = 'w-4 h-4';

export const CompactFileActions: React.FC<CompactFileActionsProps> = ({ filePath, patch, canOpen, base, markdownView, viewSwitch, viewed, onComment, stage, onEdit }) => {
  const items = [
    onComment && { label: 'Comment on this file', onSelect: onComment, icon: <MessageSquare className={ICON} /> },
    stage && { label: stage.isStaged ? 'Unstage this file' : 'Stage this file (git add)', onSelect: () => { if (!stage.isStaging) stage.onStage(); }, icon: <GitBranchPlus className={ICON} /> },
    onEdit && { label: 'Edit to suggest a change', onSelect: onEdit, icon: <PencilLine className={ICON} /> },
  ].filter((item): item is { label: string; onSelect: () => void; icon: React.ReactElement } => !!item);
  return (
    <div className="flex flex-none items-center" data-compact-file-actions="">
      {markdownView}
      {viewed && (
        <button
          type="button"
          onClick={viewed.onToggle}
          aria-pressed={viewed.isViewed}
          aria-label={viewed.isViewed ? 'Mark as not viewed' : 'Mark as viewed'}
          data-file-header-viewed=""
          data-pn-touch-target=""
          data-pn-touch-target-icon=""
          className={`flex items-center justify-center rounded ${viewed.isViewed ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            {viewed.isViewed
              ? <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              : <circle cx="12" cy="12" r="9" />}
          </svg>
        </button>
      )}
      <OpenInAppButton
        menuOnly
        filePath={filePath}
        base={base}
        diffText={patch}
        canOpen={canOpen}
        extraItems={items}
        menuHeader={viewSwitch ? <div className="px-2 py-1.5" data-compact-view-switch="">{viewSwitch}</div> : undefined}
      />
    </div>
  );
};
