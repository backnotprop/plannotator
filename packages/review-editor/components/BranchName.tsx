import React, { useLayoutEffect, useRef, useState } from 'react';

const ELLIPSIS = '…';
const TAIL = 8;

function graphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
  return Segmenter ? [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment) : Array.from(text);
}

export function fitBranch(branch: string, available: number, width: (text: string) => number): string {
  if (width(branch) <= available) return branch;
  const parts = graphemes(branch);
  const keep = Math.min(TAIL, Math.max(0, parts.length - 1));
  const tail = parts.slice(parts.length - keep).join('');
  const head = parts.slice(0, parts.length - keep);
  let low = 0;
  let high = head.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (width(`${head.slice(0, mid).join('')}${ELLIPSIS}${tail}`) <= available) low = mid;
    else high = mid - 1;
  }
  if (low > 0 || width(`${ELLIPSIS}${tail}`) <= available) return `${head.slice(0, low).join('')}${ELLIPSIS}${tail}`;
  const tailParts = graphemes(tail);
  let size = tailParts.length - 1;
  while (size > 1 && width(`${ELLIPSIS}${tailParts.slice(tailParts.length - size).join('')}`) > available) size--;
  return `${ELLIPSIS}${tailParts.slice(tailParts.length - size).join('')}`;
}

export const BranchName: React.FC<{ branch: string; minVisible?: number }> = ({ branch, minVisible = 0 }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState(branch);

  useLayoutEffect(() => {
    const element = ref.current;
    const probe = probeRef.current;
    if (!element || !probe) return;
    const fit = () => {
      const available = element.clientWidth;
      if (available <= 0) return setText(branch);
      const width = (value: string) => {
        probe.textContent = value;
        return probe.getBoundingClientRect().width;
      };
      const next = fitBranch(branch, available - 0.5, width);
      probe.textContent = '';
      setText(next);
    };
    fit();
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.addEventListener?.('loadingdone', fit);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      fonts?.removeEventListener?.('loadingdone', fit);
    };
  }, [branch]);

  const shown = text === branch || graphemes(text.replace(ELLIPSIS, '')).length >= minVisible;
  return (
    <span ref={ref} className="relative block min-w-0 overflow-hidden whitespace-nowrap" data-branch-name={branch}>
      <span aria-hidden="true" className="invisible">{branch}</span>
      {shown ? (
        <span className="absolute inset-y-0 left-0 whitespace-nowrap" data-branch-shown="">{text}</span>
      ) : (
        <span className="sr-only">{branch}</span>
      )}
      <span ref={probeRef} aria-hidden="true" className="invisible absolute left-0 top-0 whitespace-pre" />
    </span>
  );
};
