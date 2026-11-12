import React from 'react';

export const AskSessionSetupHint: React.FC<{ text?: string | null }> = ({ text }) =>
  text ? (
    <div className="-mt-1 px-2 pb-1.5 text-[10px] text-muted-foreground/70" data-ai-ask-session-setup-hint>
      {text}
    </div>
  ) : null;
