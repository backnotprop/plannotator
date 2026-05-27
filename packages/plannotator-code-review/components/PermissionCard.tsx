/**
 * Inline approve/deny card for AI tool permission requests.
 *
 * When the Claude provider's session wants to use a tool (e.g. Read a file),
 * it emits a permission_request event. The AI sidebar renders one of these
 * cards for each pending request. The user's decision is sent back via
 * respondToPermission → /api/ai/permission → session.respondToPermission.
 */
import React, { useState } from 'react';

interface PermissionCardProps {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  onRespond: (requestId: string, allow: boolean) => void;
}

const TOOL_ICONS: Record<string, string> = {
  Bash: '$ ',
  Read: '',
  Write: '',
  Edit: '',
  Glob: '',
  Grep: '',
  WebSearch: '',
  WebFetch: '',
};

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return input.command;
  }
  if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && typeof input.file_path === 'string') {
    return input.file_path;
  }
  if (toolName === 'Glob' && typeof input.pattern === 'string') {
    return input.pattern;
  }
  if (toolName === 'Grep' && typeof input.pattern === 'string') {
    return input.pattern;
  }
  return JSON.stringify(input).slice(0, 100);
}

export const PermissionCard: React.FC<PermissionCardProps> = ({
  requestId,
  toolName,
  toolInput,
  title,
  displayName,
  description,
  onRespond,
}) => {
  const [decided, setDecided] = useState<'allow' | 'deny' | null>(null);
  const [loading, setLoading] = useState(false);

  const handleDecision = (allow: boolean) => {
    setLoading(true);
    setDecided(allow ? 'allow' : 'deny');
    onRespond(requestId, allow);
  };

  const label = title || displayName || `${toolName}: ${formatToolInput(toolName, toolInput)}`;
  const prefix = TOOL_ICONS[toolName] ?? '';

  return (
    <div className="p-2.5 rounded-lg border border-warning/30 bg-warning/5">
      <div className="flex items-start gap-2">
        <div className="w-5 h-5 rounded bg-warning/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <svg className="w-3 h-3 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-medium text-warning uppercase tracking-wider mb-1">
            Permission Request
          </p>
          <p className="text-xs font-mono text-foreground/80 break-all">
            {prefix}{label}
          </p>
          {description && (
            <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>
          )}
        </div>
      </div>

      {decided ? (
        <div className={`mt-2 text-[10px] font-medium flex items-center gap-1 ${decided === 'allow' ? 'text-success' : 'text-destructive'}`}>
          {decided === 'allow' ? (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Allowed
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Denied
            </>
          )}
        </div>
      ) : (
        <div className="flex gap-2 mt-2">
          <button
            onClick={() => handleDecision(true)}
            disabled={loading}
            className="review-toolbar-btn primary disabled:opacity-50 flex-1 text-[10px]"
          >
            Allow
          </button>
          <button
            onClick={() => handleDecision(false)}
            disabled={loading}
            className="review-toolbar-btn flex-1 text-[10px]"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
};
