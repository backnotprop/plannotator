import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AIChatEntry, PendingPermission } from '../../hooks/useAIChat';
import type { AIProviderOption } from '../../utils/aiProvider';
import { formatRelativeTime, renderChatMarkdown } from '../../utils/aiChatFormat';
import { OverlayScrollArea } from '../OverlayScrollArea';
import { SparklesIcon } from '../SparklesIcon';
import { AIProviderBar } from './AIProviderBar';
import { submitHint } from '../../utils/platform';

interface DocumentAIChatPanelProps {
  messages: AIChatEntry[];
  isCreatingSession: boolean;
  isStreaming: boolean;
  onAskGeneral?: (question: string) => void;
  permissionRequests?: PendingPermission[];
  onRespondToPermission?: (requestId: string, allow: boolean) => void;
  aiProviders?: AIProviderOption[];
  aiConfig?: { providerId: string | null; model: string | null; reasoningEffort?: string | null };
  onAIConfigChange?: (config: { providerId?: string | null; model?: string | null; reasoningEffort?: string | null }) => void;
}

function truncate(text: string, max = 180): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}...`;
}

function formatToolInput(toolName: string, input: Record<string, unknown>): string | null {
  if (!input || Object.keys(input).length === 0) return null;

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
    const path = typeof input.path === 'string' ? ` in ${input.path}` : '';
    return `${input.pattern}${path}`;
  }
  if ((toolName === 'WebFetch' || toolName === 'WebSearch') && typeof input.url === 'string') {
    return input.url;
  }

  try {
    return truncate(JSON.stringify(input), 240);
  } catch {
    return String(input);
  }
}

export const DocumentAIChatPanel: React.FC<DocumentAIChatPanelProps> = ({
  messages,
  isCreatingSession,
  isStreaming,
  onAskGeneral,
  permissionRequests = [],
  onRespondToPermission,
  aiProviders = [],
  aiConfig,
  onAIConfigChange,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [generalInput, setGeneralInput] = useState('');
  const latestMessage = messages[messages.length - 1];
  const latestResponseText = latestMessage?.response.text ?? '';

  useEffect(() => {
    if (!scrollRef.current) return;
    const last = scrollRef.current.querySelector('[data-ai-message]:last-child');
    last?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, latestResponseText]);

  const handleGeneralSubmit = useCallback(() => {
    const question = generalInput.trim();
    if (!question || !onAskGeneral) return;
    onAskGeneral(question);
    setGeneralInput('');
  }, [generalInput, onAskGeneral]);

  return (
    <div className="flex flex-col h-full">
      <OverlayScrollArea className="flex-1 min-h-0">
        <div ref={scrollRef} className="p-2 space-y-3">
          {messages.length === 0 && !isCreatingSession && (
            <div className="flex flex-col items-center justify-center h-48 text-center px-4 text-muted-foreground">
              <div className="w-10 h-10 rounded-full bg-muted/50 flex items-center justify-center mb-3">
                <SparklesIcon className="w-5 h-5" />
              </div>
              <p className="text-xs">
                {onAskGeneral ? (
                  <>Select text and click <strong>Ask AI</strong>, or ask a general question below.</>
                ) : (
                  <>Select text and click <strong>Ask AI</strong>.</>
                )}
              </p>
            </div>
          )}

          {isCreatingSession && messages.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-4">
              <span className="ai-streaming-cursor" /> Starting AI session...
            </div>
          )}

          {permissionRequests.filter(p => !p.decided).map(permission => (
            <PermissionCard
              key={permission.requestId}
              permission={permission}
              onRespond={onRespondToPermission ?? (() => {})}
            />
          ))}

          {messages.map(entry => (
            <DocumentQAPair key={entry.question.id} entry={entry} />
          ))}
        </div>
      </OverlayScrollArea>

      <AIProviderBar
        providers={aiProviders}
        selectedProviderId={aiConfig?.providerId ?? null}
        selectedModel={aiConfig?.model ?? null}
        selectedReasoningEffort={aiConfig?.reasoningEffort ?? null}
        onProviderChange={(providerId) => onAIConfigChange?.({ providerId })}
        onModelChange={(model) => onAIConfigChange?.({ model })}
        onReasoningEffortChange={(reasoningEffort) => onAIConfigChange?.({ reasoningEffort })}
      />

      {onAskGeneral && (
        <GeneralInput
          value={generalInput}
          onChange={setGeneralInput}
          onSubmit={handleGeneralSubmit}
          disabled={isStreaming}
        />
      )}
    </div>
  );
};

const DocumentQAPair = memo<{ entry: AIChatEntry }>(({ entry }) => {
  const { question, response } = entry;
  const renderedResponse = useMemo(
    () => response.text ? renderChatMarkdown(response.text) : null,
    [response.text],
  );
  const scope = question.scope;

  return (
    <div data-ai-message data-question-id={question.id} className="flex flex-col gap-1.5">
      <div className="p-2.5 rounded-lg border border-transparent hover:bg-muted/30 transition-colors">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-1.5 min-w-0">
            {scope?.kind === 'selection' && (
              <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                selection
              </span>
            )}
            {scope?.label && (
              <span className="text-[10px] text-muted-foreground truncate">
                {scope.label}
              </span>
            )}
          </div>
          <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">
            {formatRelativeTime(question.createdAt)}
          </span>
        </div>
        {scope?.text && (
          <p className="text-[10px] text-muted-foreground/70 border-l border-border pl-2 mb-1.5 line-clamp-3">
            {truncate(scope.text)}
          </p>
        )}
        <p className="text-xs text-foreground/80 whitespace-pre-wrap">{question.prompt}</p>
      </div>

      <div className="group relative p-2.5 rounded-lg border border-border/50 bg-popover/50 hover:bg-muted/30 transition-colors">
        {response.error ? (
          <p className="text-xs text-destructive">{response.error}</p>
        ) : response.text ? (
          <div className="text-xs">
            {renderedResponse}
            {response.isStreaming && <span className="ai-streaming-cursor inline-block ml-0.5" />}
          </div>
        ) : response.isStreaming ? (
          <span className="text-xs text-muted-foreground">
            <span className="ai-streaming-cursor" /> Thinking...
          </span>
        ) : null}
      </div>
    </div>
  );
});

const PermissionCard: React.FC<{
  permission: PendingPermission;
  onRespond: (requestId: string, allow: boolean) => void;
}> = ({ permission, onRespond }) => {
  const label = permission.title || permission.displayName || permission.toolName;
  const toolInput = formatToolInput(permission.toolName, permission.toolInput);

  return (
    <div className="p-2.5 rounded-lg border border-warning/30 bg-warning/5">
      <p className="text-[10px] font-medium text-warning uppercase tracking-wider mb-1">
        Permission Request
      </p>
      <p className="text-xs font-mono text-foreground/80 break-all">
        {label}
      </p>
      {toolInput && (
        <p className="mt-1 px-2 py-1 rounded bg-background/60 border border-warning/20 text-[10px] font-mono text-foreground/80 break-all">
          {toolInput}
        </p>
      )}
      {permission.description && (
        <p className="text-[10px] text-muted-foreground mt-0.5">{permission.description}</p>
      )}
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => onRespond(permission.requestId, true)}
          className="flex-1 px-2 py-1.5 rounded-md bg-primary text-primary-foreground text-[10px] font-medium hover:opacity-90 transition-opacity"
        >
          Allow
        </button>
        <button
          onClick={() => onRespond(permission.requestId, false)}
          className="flex-1 px-2 py-1.5 rounded-md bg-muted text-foreground text-[10px] font-medium hover:bg-muted/80 transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  );
};

const GeneralInput: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}> = ({ value, onChange, onSubmit, disabled }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value]);

  return (
    <div className="border-t border-border/50 p-2">
      <div className="flex items-end gap-1.5">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Ask about this document..."
          rows={1}
          className="flex-1 px-2.5 py-1.5 bg-muted rounded-md text-xs text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary/50 leading-relaxed"
          style={{ maxHeight: 120 }}
          disabled={disabled}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && !disabled) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <button
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
          className="p-1.5 mb-px rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          title={`Send (${submitHint})`}
          aria-label="Send AI question"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
          </svg>
        </button>
      </div>
    </div>
  );
};
