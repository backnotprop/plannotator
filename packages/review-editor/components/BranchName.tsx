import React, { useRef } from 'react';
import { useFittedText } from '@plannotator/ui/hooks/useFittedText';
import { ELLIPSIS, fitHeadTail, graphemes } from '@plannotator/ui/utils/textFit';

const TAIL = 8;

export function fitBranch(branch: string, available: number, width: (text: string) => number): string {
  return fitHeadTail(branch, TAIL, available, width);
}

export const BranchName: React.FC<{ branch: string; minVisible?: number }> = ({ branch, minVisible = 0 }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const text = useFittedText(ref, branch, 'branch');
  const shown = text === branch || graphemes(text.replace(ELLIPSIS, '')).length >= minVisible;
  return (
    <span ref={ref} className="relative block min-w-0 overflow-hidden whitespace-nowrap" data-branch-name={branch}>
      <span aria-hidden="true" className="invisible pr-0.5">{branch}</span>
      {shown ? (
        <span className="absolute inset-y-0 left-0 whitespace-nowrap" data-branch-shown="">{text}</span>
      ) : (
        <span className="sr-only">{branch}</span>
      )}
    </span>
  );
};
