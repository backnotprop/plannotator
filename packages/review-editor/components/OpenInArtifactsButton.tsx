import React from 'react';
import { Maximize2 } from 'lucide-react';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import { findPRArtifactByUrl } from '../utils/prArtifacts';

/**
 * Under a video player in PR text: opens that video in the Artifacts panel
 * (large, comments at a timestamp). A click on the player itself plays it,
 * so the way to the panel is this button. Nothing when the list does not
 * hold the video.
 */
export function OpenInArtifactsButton({ url }: { url: string }): React.JSX.Element | null {
  const state = useReviewStateOptional();
  const artifact = state ? findPRArtifactByUrl(state.prArtifacts, state.prMetadata, url) : null;
  if (!state || artifact === null) return null;
  return (
    <button
      type="button"
      onClick={() => state.openPRArtifact(artifact.id)}
      className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Maximize2 className="h-3 w-3" aria-hidden="true" />
      Open in Artifacts
    </button>
  );
}
