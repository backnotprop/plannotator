import type React from 'react';
import { useState } from 'react';

interface CopyButtonProps {
  text: string;
  className?: string;
  /** "overlay" (default): absolute-positioned, hover-reveal (parent needs group relative).
   *  "inline": normal flow, always visible, compact. */
  variant?: 'overlay' | 'inline';
  /** Optional label shown next to the icon (inline variant only). */
  label?: string;
}

const CopyIcon = () => (
  <svg aria-hidden="true" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const CheckIcon = () => (
  <svg aria-hidden="true" className="w-3 h-3 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

/** Copy-to-clipboard button with "Copied" flash. */
export const CopyButton: React.FC<CopyButtonProps> = ({ text, className = '', variant = 'overlay', label }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may not be available
    }
  };

  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={handleCopy}
        className={`flex items-center gap-1 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors ${className}`}
        title={copied ? 'Copied!' : 'Copy'}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {label && (
          <span className="text-[10px]">
            {copied ? 'Copied' : label}
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`absolute top-1.5 right-1.5 p-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground hover:bg-muted ${className}`}
      title={copied ? 'Copied!' : 'Copy'}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
};
