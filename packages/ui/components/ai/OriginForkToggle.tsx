import React from 'react';
import type { OriginForkToggleProps } from '../../hooks/useOriginFork';

/**
 * The "Fork the <agent> session" opt-in checkbox (#1519). Shared by the
 * plan/document chat panel and the code-review chat bar — both wrap it in
 * their own border/padding container to match their surrounding layout.
 */
export const OriginForkToggle: React.FC<OriginForkToggleProps> = ({ available, enabled, onToggle, agentName }) => {
  if (!available) return null;
  return (
    <label
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none"
      title={`Start the chat as a fork of the ${agentName} session that produced this, so answers can draw on its full conversation history. Starts a fresh chat when toggled.`}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) => onToggle(event.target.checked)}
        className="accent-primary"
      />
      Fork the {agentName} session
    </label>
  );
};
