import React, { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useReviewState } from '../ReviewStateContext';
import { isReviewFilePreviewParams, type ReviewFilePanelParams } from '../reviewPanelTypes';
import { RepoFileView } from '../../components/RepoFileView';
import { ReviewDiffBody } from './ReviewDiffPanel';

export const ReviewFilePanel: React.FC<IDockviewPanelProps<ReviewFilePanelParams>> = (props) => {
  const state = useReviewState();
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
