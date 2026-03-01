import React from 'react';

/** Renders original vs suggested code as inline diff lines (git-style) */
export const SuggestionDiff: React.FC<{ original: string; suggested: string }> = ({ original, suggested }) => {
  const oldLines = original.split('\n');
  const newLines = suggested.split('\n');

  return (
    <div className="suggestion-diff">
      <div className="suggestion-diff-inner">
        {oldLines.map((line, i) => (
          <div key={`del-${i}`} className="suggestion-diff-line removed">
            <span className="suggestion-diff-indicator">{'\u2212'}</span>
            <span className="suggestion-diff-content">{line || ' '}</span>
          </div>
        ))}
        {newLines.map((line, i) => (
          <div key={`add-${i}`} className="suggestion-diff-line added">
            <span className="suggestion-diff-indicator">+</span>
            <span className="suggestion-diff-content">{line || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
