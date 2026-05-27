/**
 * Small sparkle badge injected into the diff gutter when the user has asked
 * an AI question about specific lines. Rendered inside @pierre/diffs via
 * the DiffViewer's widget slot — clicking it scrolls to the Q&A in the sidebar.
 */
import React from 'react';
import { SparklesIcon } from './SparklesIcon';

interface InlineAIMarkerProps {
  questionId: string;
  promptPreview: string;
  hasResponse: boolean;
  isStreaming: boolean;
  onClick: (questionId: string) => void;
}

export const InlineAIMarker: React.FC<InlineAIMarkerProps> = ({
  questionId,
  promptPreview,
  hasResponse,
  isStreaming,
  onClick,
}) => {
  return (
    <button
      data-ai-question-id={questionId}
      onClick={() => onClick(questionId)}
      className={`ai-marker ${hasResponse ? 'ai-marker-answered' : ''}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.375rem',
        padding: '0.1875rem 0.625rem',
        fontSize: '0.6875rem',
        border: 'none',
        background: 'none',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <SparklesIcon className="w-2.5 h-2.5" animated={isStreaming} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {promptPreview}
      </span>
    </button>
  );
};
