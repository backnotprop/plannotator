import React, { useLayoutEffect, useRef, useState } from 'react';

const ELLIPSIS = '…';

function measurer(probe: HTMLElement | null): ((text: string) => number) | null {
  if (!probe || typeof probe.getBoundingClientRect !== 'function') return null;
  probe.textContent = 'M';
  if (probe.getBoundingClientRect().width === 0) {
    probe.textContent = '';
    return null;
  }
  return (text) => {
    probe.textContent = text;
    return probe.getBoundingClientRect().width;
  };
}


function graphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
  return Segmenter ? [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((part) => part.segment) : Array.from(text);
}

export function fitMiddle(name: string, available: number, width: (text: string) => number): string {
  if (width(name) <= available) return name;
  const parts = graphemes(name);
  let low = 1;
  let high = parts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (width(`${ELLIPSIS}${parts.slice(parts.length - mid).join('')}`) <= available) low = mid;
    else high = mid - 1;
  }
  return `${ELLIPSIS}${parts.slice(parts.length - Math.max(1, low)).join('')}`;
}

export function fitDirectory(directory: string, available: number, width: (text: string) => number): string {
  if (width(directory) <= available) return directory;
  const parts = directory.split('/').filter(Boolean);
  for (let drop = 1; drop < parts.length; drop++) {
    const candidate = `${ELLIPSIS}/${parts.slice(drop).join('/')}/`;
    if (width(candidate) <= available) return candidate;
  }
  return '';
}

export const EllipsisName: React.FC<{ text: string; className?: string; title?: string }> = ({
  text,
  className,
  title,
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState<{ text: string; width?: number }>({ text });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      const probe = probeRef.current;
      const width = measurer(probe);
      if (!width || !probe) {
        setFitted((before) => (before.text === text && !before.width ? before : { text }));
        return;
      }
      const full = Math.ceil(width(text)) + 1;
      const available = element.clientWidth;
      const next = available > 0 && available < full ? fitMiddle(text, available, width) : text;
      probe.textContent = '';
      setFitted((before) => (before.text === next && before.width === full ? before : { text: next, width: full }));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      ref={ref}
      title={title}
      data-ellipsis-name={text}
      className={`relative block min-w-0 shrink overflow-hidden whitespace-nowrap [font-variant-ligatures:no-contextual] ${className ?? ''}`}
      style={fitted.width ? { width: fitted.width } : undefined}
    >
      {fitted.text}
      <span ref={probeRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap" />
    </span>
  );
};
