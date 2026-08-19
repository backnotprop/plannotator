import React from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';

export function CallFlowSearchControls({
  inputRef,
  label,
  placeholder,
  query,
  currentMatchIndex,
  matchCount,
  onQueryChange,
  onMoveMatch,
  onClose,
}: {
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly label: string;
  readonly placeholder: string;
  readonly query: string;
  readonly currentMatchIndex: number;
  readonly matchCount: number;
  readonly onQueryChange: (query: string) => void;
  readonly onMoveMatch: (direction: 1 | -1) => void;
  readonly onClose: () => void;
}) {
  return (
    <form
      className="call-flow-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onMoveMatch(1);
      }}
    >
      <label className="call-flow-search-field">
        <Search aria-hidden="true" size={13} strokeWidth={1.75} />
        <span className="sr-only">{label}</span>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              onMoveMatch(event.shiftKey ? -1 : 1);
            }
          }}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
        />
      </label>
      <span className="call-flow-search-count" aria-live="polite">
        {matchCount === 0 ? '0/0' : `${Math.min(currentMatchIndex + 1, matchCount)}/${matchCount}`}
      </span>
      <button
        type="button"
        className="call-flow-icon-button"
        onClick={() => onMoveMatch(-1)}
        disabled={matchCount === 0}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp aria-hidden="true" size={14} />
      </button>
      <button
        type="button"
        className="call-flow-icon-button"
        onClick={() => onMoveMatch(1)}
        disabled={matchCount === 0}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      <button
        type="button"
        className="call-flow-icon-button"
        onClick={onClose}
        aria-label="Close search"
      >
        <X aria-hidden="true" size={14} />
      </button>
    </form>
  );
}
