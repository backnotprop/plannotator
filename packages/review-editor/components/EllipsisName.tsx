import React, { useRef } from 'react';
import { useFittedText } from '@plannotator/ui/hooks/useFittedText';
import { fitDirectory as fitDirectoryText, fitStart } from '@plannotator/ui/utils/textFit';

export function fitMiddle(name: string, available: number, width: (text: string) => number): string {
  return fitStart(name, available, width);
}

export function fitDirectory(directory: string, available: number, width: (text: string) => number): string {
  return fitDirectoryText(directory, available, width);
}

export const EllipsisName: React.FC<{ text: string; className?: string; title?: string }> = ({
  text,
  className,
  title,
}) => {
  const ref = useRef<HTMLSpanElement>(null);
  const fitted = useFittedText(ref, text, 'start');

  return (
    <span
      ref={ref}
      title={title}
      data-ellipsis-name={text}
      className={`relative block min-w-0 shrink overflow-hidden whitespace-nowrap [font-variant-ligatures:no-contextual] ${className ?? ''}`}
      style={fitted.natural ? { width: fitted.natural } : undefined}
    >
      {fitted.text}
    </span>
  );
};
