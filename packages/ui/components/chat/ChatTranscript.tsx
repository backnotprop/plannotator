import { createContext, memo, useContext, useEffect, useMemo, useRef } from 'react';
import type * as React from 'react';

import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { cn } from '../../lib/utils';
import { chatTextRenderer } from './chatMarkdown';
import { FOCUS_RING } from './chatRecipes';

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

export type ChatMessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessagePart {
  readonly type: string;
}

export interface ChatTextPart extends ChatMessagePart {
  readonly type: 'text';
  readonly text: string;
  readonly state?: 'streaming' | 'done';
}

export interface ChatMessage<Part extends ChatMessagePart = ChatMessagePart> {
  readonly id: string;
  readonly role: ChatMessageRole;
  readonly parts: readonly Part[];
}

function isTextPart(part: ChatMessagePart): part is ChatTextPart {
  return part.type === 'text';
}

/**
 * Clip a still-streaming text at its last completed sentence or paragraph, so under reduced
 * motion whole sentences append and never single words.
 */
export function clipAtSentenceBoundary(text: string): string {
  let cut = 0;
  for (const match of text.matchAll(/[.!?](?=\s)|\n/gu)) {
    cut = (match.index ?? 0) + match[0].length;
  }
  return text.slice(0, cut);
}

/**
 * Has this assistant turn painted anything yet? Under reduced motion a text part still streaming
 * paints nothing before its first sentence ends.
 */
export function chatTurnHasOutput(message: ChatMessage, reducedMotion = false): boolean {
  return message.parts.some((part) => {
    if (part.type === 'step-start') return false;
    if (!isTextPart(part)) return true;
    const clipped = reducedMotion && part.state === 'streaming';
    return (clipped ? clipAtSentenceBoundary(part.text) : part.text).length > 0;
  });
}

const BODY_PROSE = cn(
  'min-w-0 text-sm text-foreground [overflow-wrap:anywhere]',
  '[&_p]:mb-2 [&_p:last-child]:mb-0',
  '[&_pre]:mb-2 [&_pre]:overflow-x-auto',
  '[&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mb-1',
  '[&_code]:font-mono [&_code]:text-xs [&_code]:text-primary',
  '[&_strong]:font-semibold',
  '[&_blockquote]:mb-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border-subtle [&_blockquote]:pl-2.5 [&_blockquote]:italic [&_blockquote]:text-muted-foreground',
  '[&_a]:text-primary',
  '[&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold',
);

const TurnLiveContext = createContext(true);

/**
 * The transcript's `richMarkdown`, so a host's own `ChatMarkdown` in `renderPart` draws what the
 * transcript's would, without saying so a second time.
 */
const RichMarkdownContext = createContext(false);

const KeepUserBlankLinesContext = createContext(false);

/** One text part as sanitized markdown, memoized on its text. */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  streaming = false,
  literalHtml = false,
  richMarkdown,
  keepBlankLines,
  messageId,
  role,
  partIndex,
  annotatable,
  rootRef,
}: {
  text: string;
  /** Still receiving deltas: under reduced motion the paint holds at the last completed sentence. */
  streaming?: boolean;
  literalHtml?: boolean;
  richMarkdown?: boolean;
  keepBlankLines?: boolean;
  messageId?: string;
  role?: ChatMessageRole;
  partIndex?: number;
  annotatable?: boolean;
  rootRef?: React.Ref<HTMLDivElement>;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const live = useContext(TurnLiveContext) && streaming;
  const shown = live && reducedMotion ? clipAtSentenceBoundary(text) : text;
  const transcriptRich = useContext(RichMarkdownContext);
  const rich = richMarkdown ?? transcriptRich;
  const transcriptKeep = useContext(KeepUserBlankLinesContext);
  const keep = literalHtml && (keepBlankLines ?? transcriptKeep);
  const render = useMemo(() => chatTextRenderer(literalHtml, rich, keep), [literalHtml, rich, keep]);
  const html = useMemo(() => render(shown, live), [render, shown, live]);
  const inner = useMemo(() => ({ __html: html }), [html]);
  return (
    <div
      ref={rootRef}
      className={BODY_PROSE}
      data-text-part={messageId === undefined ? undefined : ''}
      data-message-id={messageId}
      data-message-role={role}
      data-part-index={partIndex}
      data-annotatable={annotatable === undefined ? undefined : String(annotatable)}
      dangerouslySetInnerHTML={inner}
    />
  );
});

/** The answer's place in the list, from the send until the reply's first part. */
export function ChatPendingTurn({
  agentName,
  agentMark,
  label = 'Thinking…',
  indentContent = false,
}: {
  agentName: string;
  agentMark?: React.ReactNode;
  label?: React.ReactNode;
  indentContent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-message-role="assistant" data-chat-pending>
      <div className="flex items-center gap-2 text-xs">
        {agentMark}
        <span className="font-semibold text-foreground">{agentName}</span>
      </div>
      <div className={cn('flex min-w-0 items-center gap-2 text-xs text-tertiary', indentContent && 'pl-7')}>
        <span
          aria-hidden="true"
          className="size-3 shrink-0 animate-spin rounded-full border border-border border-t-primary motion-reduce:animate-pulse"
        />
        <span>{label}</span>
      </div>
    </div>
  );
}

/** Where a part sits, for a host drawing it: which message, and which part of it. */
export interface ChatPartContext<Part extends ChatMessagePart = ChatMessagePart> {
  readonly message: ChatMessage<Part>;
  readonly index: number;
}

export function ChatMessageView<Part extends ChatMessagePart = ChatMessagePart>({
  message,
  agentName,
  agentMark,
  agentBadge,
  userName = 'You',
  userMark,
  stopped = false,
  stoppedLabel = 'Stopped',
  indentContent = false,
  renderPart,
  footer,
  richMarkdown,
  keepUserBlankLines,
}: {
  message: ChatMessage<Part>;
  agentName: string;
  agentMark?: React.ReactNode;
  agentBadge?: React.ReactNode;
  userName?: string;
  userMark?: React.ReactNode;
  stopped?: boolean;
  stoppedLabel?: string;
  indentContent?: boolean;
  renderPart?: (part: Part, context: ChatPartContext<Part>) => React.ReactNode | undefined;
  footer?: React.ReactNode;
  richMarkdown?: boolean;
  keepUserBlankLines?: boolean;
}) {
  const isUser = message.role === 'user';
  return (
    <div className="flex flex-col gap-1.5" data-message-role={message.role}>
      <div className="flex items-center gap-2 text-xs">
        {isUser ? userMark : agentMark}
        <span className="font-semibold text-foreground">{isUser ? userName : agentName}</span>
        {!isUser && agentBadge}
        {stopped && (
          <span className="inline-flex h-5 items-center rounded-sm border border-border bg-muted px-1.5 text-2xs font-medium text-muted-foreground">
            {stoppedLabel}
          </span>
        )}
      </div>
      <div className={cn('flex min-w-0 flex-col gap-2', indentContent && 'pl-7')}>
        {message.parts.map((part, index) => {
          const custom = renderPart?.(part, { message, index });
          if (custom === null) return null;
          if (custom !== undefined) return <div key={index}>{custom}</div>;
          if (!isTextPart(part)) return null;
          return (
            <ChatMarkdown
              key={index}
              text={part.text}
              streaming={part.state === 'streaming'}
              literalHtml={isUser}
              richMarkdown={richMarkdown}
              keepBlankLines={isUser ? keepUserBlankLines : undefined}
              messageId={message.id}
              role={message.role}
              partIndex={index}
            />
          );
        })}
        {footer}
      </div>
    </div>
  );
}

export interface ChatTranscriptProps<Part extends ChatMessagePart = ChatMessagePart> {
  readonly messages: readonly ChatMessage<Part>[];
  readonly status: ChatStatus;
  readonly agentName: string;
  readonly agentMark?: React.ReactNode;
  readonly agentBadge?: React.ReactNode;
  readonly userName?: string;
  readonly userMark?: React.ReactNode;
  readonly empty?: React.ReactNode;
  readonly statusLine?: string | null;
  /** The pane's accessible name. */
  readonly label?: string;
  readonly panel?: { readonly id: string; readonly labelledBy: string };
  readonly stopped?: ReadonlySet<string>;
  readonly stoppedLabel?: string;
  readonly indentContent?: boolean;
  readonly pending?: React.ReactNode | false;
  readonly renderPart?: (part: Part, context: ChatPartContext<Part>) => React.ReactNode | undefined;
  readonly renderMessage?: (message: ChatMessage<Part>, index: number) => React.ReactNode | undefined;
  readonly messageFooter?: (message: ChatMessage<Part>) => React.ReactNode;
  readonly scrollRef?: React.RefObject<HTMLDivElement | null>;
  readonly overlay?: React.ReactNode;
  readonly richMarkdown?: boolean;
  readonly keepUserBlankLines?: boolean;
}

/**
 * A part's `state` alone cannot say so, because a stopped turn can leave it `streaming`, so this
 * goes by what the host knows: `submitted` starts a new turn, `streaming` goes on with the one
 * under way, and `stopped` names a turn that is over.
 */
function arrivingIndex<Part extends ChatMessagePart>(
  messages: readonly ChatMessage<Part>[],
  status: ChatStatus,
  stopped: ReadonlySet<string> | undefined,
): number {
  if (status !== 'submitted' && status !== 'streaming') return -1;
  const last = messages.length - 1;
  if (status === 'submitted') return last;
  let answerAt = last;
  while (answerAt >= 0 && messages[answerAt].role === 'user') answerAt -= 1;
  const answer = messages[answerAt];
  const unfinished =
    answer !== undefined &&
    !stopped?.has(answer.id) &&
    answer.parts.some((part) => isTextPart(part) && part.state === 'streaming');
  return unfinished ? answerAt : last;
}

export function ChatTranscript<Part extends ChatMessagePart = ChatMessagePart>({
  messages,
  status,
  agentName,
  agentMark,
  agentBadge,
  userName,
  userMark,
  empty,
  statusLine,
  label = 'Conversation',
  panel,
  stopped,
  stoppedLabel,
  indentContent = false,
  pending: pendingLine,
  renderPart,
  renderMessage,
  messageFooter,
  scrollRef,
  overlay,
  richMarkdown = false,
  keepUserBlankLines = false,
}: ChatTranscriptProps<Part>) {
  const running = status === 'submitted' || status === 'streaming';
  const reducedMotion = usePrefersReducedMotion();
  const arrivingAt = arrivingIndex(messages, status, stopped);
  const arriving = messages[arrivingAt];
  const answerStarted =
    arriving !== undefined &&
    arriving.role === 'assistant' &&
    chatTurnHasOutput(arriving, reducedMotion && running);
  const pending = running && !answerStarted && pendingLine !== false;

  const ownRef = useRef<HTMLDivElement | null>(null);
  const paneRef = scrollRef ?? ownRef;
  const atBottomRef = useRef(true);
  useEffect(() => {
    const node = paneRef.current;
    if (node !== null && atBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [messages, statusLine, pending, paneRef]);
  useEffect(() => {
    const node = paneRef.current;
    if (node === null || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [paneRef]);

  // Only with `richMarkdown`: otherwise no image in text can load, and a host's own image must not
  // move the pane.
  const followImage = () => {
    const node = paneRef.current;
    if (node !== null && atBottomRef.current) node.scrollTop = node.scrollHeight;
  };

  const drawn = (message: ChatMessage<Part>, live: boolean): boolean =>
    message.role === 'user' ||
    (message.role === 'assistant' && chatTurnHasOutput(message, reducedMotion && live));

  const pane = (
    <div
      ref={paneRef}
      onScroll={(event) => {
        const node = event.currentTarget;
        atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}
      onLoadCapture={richMarkdown ? followImage : undefined}
      // Focusable, so a keyboard user can Tab in and arrow-scroll. Deliberately
      // not a live region: streamed deltas would announce token by token.
      role={panel === undefined ? 'region' : 'tabpanel'}
      tabIndex={0}
      id={panel?.id}
      aria-label={panel === undefined ? label : undefined}
      aria-labelledby={panel?.labelledBy}
      className={cn(
        'relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3.5',
        FOCUS_RING,
      )}
    >
      {overlay}
      {messages.length === 0
        ? empty
        : messages.map((message, index) => {
            const live = index === arrivingAt;
            const custom = renderMessage?.(message, index);
            return (
              <TurnLiveContext.Provider key={message.id} value={live}>
                {custom !== undefined ? (
                  custom
                ) : drawn(message, live) ? (
                  <ChatMessageView
                    message={message}
                    agentName={agentName}
                    agentMark={agentMark}
                    agentBadge={agentBadge}
                    userName={userName}
                    userMark={userMark}
                    stopped={stopped?.has(message.id) ?? false}
                    stoppedLabel={stoppedLabel}
                    indentContent={indentContent}
                    renderPart={renderPart}
                    footer={messageFooter?.(message)}
                  />
                ) : null}
              </TurnLiveContext.Provider>
            );
          })}
      {pending && (
        <ChatPendingTurn
          agentName={agentName}
          agentMark={agentMark}
          label={pendingLine ?? undefined}
          indentContent={indentContent}
        />
      )}
      {statusLine && (
        <p role="status" className="text-xs text-muted-foreground">
          {statusLine}
        </p>
      )}
    </div>
  );
  return (
    <RichMarkdownContext.Provider value={richMarkdown}>
      <KeepUserBlankLinesContext.Provider value={keepUserBlankLines}>{pane}</KeepUserBlankLinesContext.Provider>
    </RichMarkdownContext.Provider>
  );
}
