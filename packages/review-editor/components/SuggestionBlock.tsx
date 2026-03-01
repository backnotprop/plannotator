import React from 'react';
import { HighlightedCode } from './HighlightedCode';
import { SuggestionDiff } from './SuggestionDiff';

/** Suggestion display with header + diff or highlighted code */
export const SuggestionBlock: React.FC<{
  code: string;
  originalCode?: string;
  language?: string;
  compact?: boolean;
}> = ({ code, originalCode, language, compact }) => {
  return (
    <div className={`suggestion-block${compact ? ' compact' : ''}`}>
      <div className="suggestion-block-header">
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16m-7 6h7" />
        </svg>
        Suggestion
      </div>
      {originalCode ? (
        <SuggestionDiff original={originalCode} suggested={code} />
      ) : (
        <pre className="suggestion-block-code"><HighlightedCode code={code} language={language} /></pre>
      )}
    </div>
  );
};
