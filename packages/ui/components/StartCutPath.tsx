import React from 'react';

/**
 * A path on one line, cut from the start when it outgrows its box: its last
 * name (a file's or a folder's) stays whole, and the folders before it show as
 * far as the room allows (`…ges\add-refund-flow\proposal.md`). Only a last name
 * longer than the whole box has its end cut, with the folders down to their
 * "…". Separators stay as given.
 *
 * The folders sit in a right-to-left box, which puts the ellipsis at the
 * start, with the path isolated left to right inside it, so a drive letter, a
 * UNC prefix or a leading or trailing separator keeps its place instead of
 * jumping to the other end. Their floor is 2ch: in some fonts the ellipsis is
 * wider than one character, and Chrome draws none in a box it does not fit.
 */
export function StartCutPath({ path, className = '' }: { path: string; className?: string }) {
  // The last name keeps any trailing separator (a folder given as `docs/`).
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
