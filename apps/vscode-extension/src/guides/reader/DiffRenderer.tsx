import React from "react";
import type { DiffTokenEventBaseProps, SelectedLineRange } from "@pierre/diffs";
import { AllFilesCodeView } from "@plannotator/review-editor/components/AllFilesCodeView";
import type { GuideDiffRendererProps } from "@plannotator/guide-viewer/host";
import type { CodeNavRequest } from "@plannotator/shared/code-nav";
import type { AIChatEntry } from "@plannotator/ui/hooks/useAIChat";

const EMPTY_ANNOTATIONS: never[] = [];
const noop = () => {};

/** What the Guide tab passes every file's diff, beside the guide chain's own props. */
export interface ReaderDiffProps {
  fontFamily: string | undefined;
  fontSize: string | undefined;
  onTokenHoverEnter: (props: DiffTokenEventBaseProps, filePath: string) => void;
  onTokenHoverLeave: () => void;
  onCodeNavRequest: (request: CodeNavRequest) => void;
  /** Ask the agent about the selected lines of a file. Absent: no asking (no agent). */
  onAskAIForFile?: (filePath: string, question: string) => void;
  aiMessages: AIChatEntry[];
  onClickAIMarker: (questionId: string) => void;
  isAILoading: boolean;
  /** This file's selected lines (the selection toolbar opens on them). */
  pendingSelection: SelectedLineRange | null;
  onLineSelection: (range: SelectedLineRange | null) => void;
  viewedFiles: Set<string>;
  onToggleViewed: (filePath: string) => void;
}

/**
 * The Guide tab's diff renderer: Plannotator's own `AllFilesCodeView`, the
 * same component guides.show and the review app use, unified at tab width.
 * `commentOnly` + `askOnly` give line selection and the selection toolbar
 * as an Ask box (the agent answers; there are no comments here), with no
 * review server behind it; without an agent to ask it is `readOnly`. Hover and
 * ⌘/Ctrl-click go to the extension, which asks the language server.
 */
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
