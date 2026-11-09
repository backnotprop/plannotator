import React, { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useReviewState } from '../ReviewStateContext';
import { isReviewFilePreviewParams, type ReviewFilePanelParams } from '../reviewPanelTypes';
import { RepoFileView } from '../../components/RepoFileView';
import { ReviewDiffBody } from './ReviewDiffPanel';

/**
 * Any file of the repository in a tab (approved design record
 * "review-explorer", step 2): a changed file shows its diff (with Changes |
 * Whole file), any other file is shown whole and read-only, "Not in this
 * review". The preview tab is replaced by the next file opened with a single
 * click; commenting in it keeps it.
 */
export const ReviewFilePanel: React.FC<IDockviewPanelProps<ReviewFilePanelParams>> = (props) => {
  const state = useReviewState();
  // dockview hands the first params as props; later ones (the preview tab
  // retargeted) arrive through onDidParametersChange.
  const readParams = (): ReviewFilePanelParams | undefined => {
    const fromApi = props.api.getParameters<ReviewFilePanelParams>();
    return fromApi?.filePath ? fromApi : props.params;
  };
  const [params, setParams] = useState<ReviewFilePanelParams | undefined>(readParams);
  useEffect(() => {
    setParams(readParams());
    const disposable = props.api.onDidParametersChange((next) => {
      const value = next as ReviewFilePanelParams | undefined;
      setParams(value?.filePath ? value : readParams());
    });
    return () => disposable.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.api, props.params]);

  const filePath = params?.filePath ?? null;
  const preview = isReviewFilePreviewParams(params);
  const keep = () => {
    if (preview && filePath) state.onKeepFileTab?.(props.api.id);
  };
  if (!filePath) return null;
  const changed = state.files.some((file) => file.path === filePath);
  if (changed) return <ReviewDiffBody filePath={filePath} onKeep={keep} />;
  return (
    <RepoFileView
      key={filePath}
      filePath={filePath}
      snapshotId={state.snapshotId}
      preview={preview}
      annotations={state.allAnnotations}
      selectedAnnotationId={state.selectedAnnotationId}
      onAddAnnotation={state.onAddWholeFileAnnotation ? (input) => {
        keep();
        state.onAddWholeFileAnnotation!(input, { inDiff: false });
      } : undefined}
      onEditAnnotation={(id, text) => state.onEditAnnotation(id, text)}
      onDeleteAnnotation={state.onDeleteAnnotation}
      onSelectAnnotation={state.onSelectAnnotation}
      revealTarget={state.revealTarget}
      crumb={state.jumpCrumb}
      onNavigateBack={state.navigation?.back}
      tokens={state.fileTokens?.(filePath)}
    />
  );
};
