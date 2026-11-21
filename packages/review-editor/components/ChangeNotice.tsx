import React, { useLayoutEffect } from 'react';

export const ChangeNotice: React.FC<{ text: string; onHeightChange?: () => void }> = ({ text, onHeightChange }) => {
  useLayoutEffect(() => {
    onHeightChange?.();
  }, []);
  return (
    <div data-change-notice="" className="px-4 py-2 text-xs leading-relaxed text-muted-foreground border-b border-border bg-muted/30 [font-variant-ligatures:no-contextual]">
      {text}
    </div>
  );
};
