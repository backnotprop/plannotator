import React from 'react';

/** Only a last name longer than the whole box has its end cut, with the folders down to their "…". */
export function StartCutPath({ path, className = '' }: { path: string; className?: string }) {
  const trimmed = path.replace(/[\\/]+$/, '');
  const lastStart = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
  const folders = path.slice(0, lastStart);
  const last = path.slice(lastStart);
  return (
    <span data-start-cut-path="" className={`flex min-w-0 ${className}`}>
      {folders && (
        <span data-start-cut-path-folders="" className="min-w-[2ch] truncate [direction:rtl]">
          <bdi dir="ltr">{folders}</bdi>
        </span>
      )}
      <span
        data-start-cut-path-last=""
        className={`truncate ${folders ? 'flex-shrink-0 max-w-[calc(100%_-_2ch)]' : 'min-w-0'}`}
      >
        {last}
      </span>
    </span>
  );
}
