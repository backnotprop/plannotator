import React from 'react';

/**
 * The muted line under an Ask AI provider bar that says how to get "Ask this
 * session" (text from askSessionSetupHint). Renders nothing without text.
 */
export const AskSessionSetupHint: React.FC<{ text?: string | null }> = ({ text }) =>
  text ? (
    <div className="-mt-1 px-2 pb-1.5 text-[10px] text-muted-foreground/70" data-ai-ask-session-setup-hint>
      {text}
    </div>
  ) : null;
