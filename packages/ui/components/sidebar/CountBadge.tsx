import React from "react";

export const CountBadge: React.FC<{ count: number; active?: boolean; className?: string }> = ({ count, active, className }) => (
  <span
    className={`flex-shrink-0 min-w-[18px] h-[18px] px-1 rounded flex items-center justify-center text-[10px] font-mono leading-none ${
      active ? 'text-primary bg-primary/15' : 'text-muted-foreground bg-muted/70'
    } ${className ?? ''}`}
  >
    {count}
  </span>
);
