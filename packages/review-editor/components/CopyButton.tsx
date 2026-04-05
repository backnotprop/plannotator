import type React from 'react';
import { useState } from 'react';
import { CopyIcon } from '../icons/CopyIcon';
import { CheckIcon } from '../icons/CheckIcon';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';

interface CopyButtonProps {
  text: string;
  className?: string;
  variant?: 'overlay' | 'inline';
}

/** Hover-reveal copy button with "Copied" flash. Parent needs className="group relative". */
export const CopyButton: React.FC<CopyButtonProps> = ({ text, className = '', variant = 'overlay' }) => {
  const { copied, copy } = useCopyToClipboard(text, 2000);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    copy();
  };

  const iconSize = variant === 'inline' ? 'w-3 h-3' : 'w-4 h-4';

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`absolute top-1.5 right-1.5 p-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground hover:bg-muted ${className}`}
      title={copied ? 'Copied!' : 'Copy'}
      aria-label={copied ? 'Copied!' : 'Copy'}
    >
      {copied ? (
        <CheckIcon className={`${iconSize} text-success`} aria-hidden="true" />
      ) : (
        <CopyIcon className={iconSize} aria-hidden="true" />
      )}
    </button>
  );
};