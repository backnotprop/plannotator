import React from "react";
import type { DiffTokenEventBaseProps, SelectedLineRange } from "@pierre/diffs";
import { AllFilesCodeView } from "@plannotator/review-editor/components/AllFilesCodeView";
import type { GuideDiffRendererProps } from "@plannotator/guide-viewer/host";
import type { CodeNavRequest } from "@plannotator/shared/code-nav";
import type { AIChatEntry } from "@plannotator/ui/hooks/useAIChat";

const EMPTY_ANNOTATIONS: never[] = [];
const noop = () => {};

export interface ReaderDiffProps {
  fontFamily: string | undefined;
  fontSize: string | undefined;
  onTokenHoverEnter: (props: DiffTokenEventBaseProps, filePath: string) => void;
  onTokenHoverLeave: () => void;
  onCodeNavRequest: (request: CodeNavRequest) => void;
  onAskAIForFile?: (filePath: string, question: string) => void;
  aiMessages: AIChatEntry[];
  onClickAIMarker: (questionId: string) => void;
  isAILoading: boolean;
  pendingSelection: SelectedLineRange | null;
  onLineSelection: (range: SelectedLineRange | null) => void;
  viewedFiles: Set<string>;
  onToggleViewed: (filePath: string) => void;
}

export const ReaderDiffRenderer: React.FC<GuideDiffRendererProps & ReaderDiffProps> = (props) => {
  const { fontFamily, fontSize, onTokenHoverEnter, onTokenHoverLeave, onCodeNavRequest, onAskAIForFile, aiMessages, onClickAIMarker, isAILoading, pendingSelection, onLineSelection, viewedFiles, onToggleViewed, ...guide } = props;
  const canAsk = !!onAskAIForFile;
  return (
    <AllFilesCodeView
      {...guide}
      commentOnly={canAsk}
      readOnly={!canAsk}
      askOnly
      viewedFiles={viewedFiles}
      onToggleViewed={onToggleViewed}
      diffStyle="unified"
      diffOverflow="scroll"
      diffIndicators="bars"
      lineDiffType="word-alt"
      fontFamily={fontFamily}
      fontSize={fontSize}
      annotations={EMPTY_ANNOTATIONS}
      selectedAnnotationId={null}
      scrollTargetAnnotation={null}
      pendingSelection={pendingSelection}
      onLineSelection={onLineSelection}
      onAddAnnotationForFile={noop}
      onEditAnnotation={noop}
      onSelectAnnotation={noop}
      onDeleteAnnotation={noop}
      onTokenHoverEnter={onTokenHoverEnter}
      onTokenHoverLeave={onTokenHoverLeave}
      onCodeNavRequest={onCodeNavRequest}
      aiAvailable={!!onAskAIForFile}
      onAskAIForFile={onAskAIForFile}
      isAILoading={isAILoading}
      aiMessages={aiMessages}
      onClickAIMarker={onClickAIMarker}
      onViewAIResponse={(id) => id && onClickAIMarker(id)}
    />
  );
};
