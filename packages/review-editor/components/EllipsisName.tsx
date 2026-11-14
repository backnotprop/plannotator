import React, { useLayoutEffect, useRef, useState } from 'react';

const ELLIPSIS = '…';
const FILE_EXTENSION = /^(.+?)(\.[A-Za-z0-9]{1,8})$/;

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

export function splitExtension(name: string): { stem: string; extension: string } {
  const match = FILE_EXTENSION.exec(name);
  return match ? { stem: match[1]!, extension: match[2]! } : { stem: name, extension: '' };
}

export function fitMiddle(name: string, available: number, width: (text: string) => number, keepExtension = true): string {
  if (width(name) <= available) return name;
  const { stem, extension } = keepExtension ? splitExtension(name) : { stem: name, extension: '' };
  let low = 0;
  let high = stem.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (width(`${stem.slice(0, mid)}${ELLIPSIS}${extension.slice(1)}`) <= available) low = mid;
    else high = mid - 1;
  }
  return `${stem.slice(0, Math.max(1, low))}${ELLIPSIS}${extension.slice(1)}`;
}

export const EllipsisName: React.FC<{ text: string; keepExtension?: boolean; className?: string; title?: string }> = ({
  text,
  keepExtension = true,
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
      const next = available > 0 && available < full ? fitMiddle(text, available, width, keepExtension) : text;
      probe.textContent = '';
      setFitted((before) => (before.text === next && before.width === full ? before : { text: next, width: full }));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, keepExtension]);

  return (
    <span
      ref={ref}
      title={title}
      data-ellipsis-name={text}
      className={`relative block min-w-0 shrink overflow-hidden whitespace-nowrap ${className ?? ''}`}
      style={fitted.width ? { width: fitted.width } : undefined}
    >
      {fitted.text}
      <span ref={probeRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap" />
    </span>
  );
};
