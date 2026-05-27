import type React from 'react';

interface CountBadgeProps {
  count: number;
  className?: string;
}

/** Compact mono count badge — consistent across file tree, annotations, and AI tabs */
export const CountBadge: React.FC<CountBadgeProps> = ({ count, className = '' }) => (
  <span className={`text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground ${className}`}>
    {count}
  </span>
);
