import React, { useId } from 'react';

interface NewChatButtonProps {
  onNewChat: () => void;
  busy?: boolean;
  pendingChoice?: boolean;
  sessionBridge?: boolean;
}

export function newChatLabels(sessionBridge: boolean): { label: string; title: string } {
  return sessionBridge
    ? {
        label: 'Clear chat',
        title: 'Clear this panel. The session that opened Plannotator still remembers earlier questions.',
      }
    : {
        label: 'New chat',
        title: 'Clear this chat and start a fresh AI session',
      };
}

export function newChatBlockedReason(options: { busy?: boolean; pendingChoice?: boolean }): string | null {
  if (options.busy) return 'Wait for the answer, or stop it, before starting a new chat.';
  if (options.pendingChoice) return 'First choose "Ask when it finishes" or "Interrupt and ask now" for the waiting question.';
  return null;
}

export const NewChatButton: React.FC<NewChatButtonProps> = ({
  onNewChat,
  busy = false,
  pendingChoice = false,
  sessionBridge = false,
}) => {
  const { label, title } = newChatLabels(sessionBridge);
  const blocked = newChatBlockedReason({ busy, pendingChoice });
  const descriptionId = useId();
  return (
    <div className="flex items-center justify-end px-2 pt-1.5 pb-0.5" data-ai-new-chat-row>
      <button
        type="button"
        onClick={() => { if (!blocked) onNewChat(); }}
        aria-disabled={blocked ? true : undefined}
        aria-describedby={descriptionId}
        title={blocked ?? title}
        data-ai-new-chat
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        {label}
      </button>
      <span id={descriptionId} className="sr-only" data-ai-new-chat-description>
        {blocked ?? title}
      </span>
    </div>
  );
};
