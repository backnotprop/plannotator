import React, { useCallback, useMemo } from 'react';
import type { AgentJobInfo } from '@plannotator/ui/types';
import type { FindingLike } from '@plannotator/ui/components/AgentsTab';
import { useSavedGuides } from '../hooks/guide/useSavedGuides';
import { GuidesList } from './guide/GuidesList';

export function reviewScopeText({
  prLabel,
  noun,
  connector,
  base,
  files,
}: {
  prLabel?: string | null;
  noun: string;
  connector: string | null;
  base?: string | null;
  files: ReadonlyArray<{ additions: number; deletions: number }>;
}): string {
  const what = prLabel ?? [noun, connector && base ? `${connector} ${base}` : null].filter(Boolean).join(' ');
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  return [what, count, `+${additions} −${deletions}`].join(' · ');
}

export function useAgentsPanelSlots({
  enabled,
  prMode,
  contextKey,
  jobs,
  onOpenGuide,
  openDiffFile,
  navigateToAnnotation,
}: {
  enabled: boolean;
  prMode: boolean;
  contextKey: string;
  jobs: AgentJobInfo[];
  onOpenGuide: (jobId: string) => void;
  openDiffFile: (filePath: string) => void;
  navigateToAnnotation: (id: string | null) => void;
}) {
  const doneGuides = jobs.filter((j) => j.provider === 'guide' && j.status === 'done').length;
  const saved = useSavedGuides(enabled, `${contextKey}|${doneGuides}`);
  const onOpenFinding = useCallback(
    (finding: FindingLike) => {
      if (finding.filePath) openDiffFile(finding.filePath);
      if (finding.id) navigateToAnnotation(finding.id);
    },
    [openDiffFile, navigateToAnnotation],
  );
  const renderGuides = useCallback(
    ({ startGuide }: { startGuide: (() => void) | null }) => (
      <GuidesList
        guides={saved.guides}
        prMode={prMode}
        onOpen={onOpenGuide}
        onRename={saved.rename}
        onDelete={saved.remove}
        onStart={startGuide ?? undefined}
      />
    ),
    [saved.guides, saved.rename, saved.remove, prMode, onOpenGuide],
  );
  return useMemo(
    () => ({ agentsGuides: renderGuides, onOpenFinding, savedGuides: saved.guides }),
    [renderGuides, onOpenFinding, saved.guides],
  );
}
