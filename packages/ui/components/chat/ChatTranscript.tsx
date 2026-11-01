import { createContext, memo, useContext, useEffect, useMemo, useRef } from 'react';
import type * as React from 'react';

import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { cn } from '../../lib/utils';
import { chatTextRenderer } from './chatMarkdown';
import { FOCUS_RING } from './chatRecipes';

/** The status of the turn in progress. */
export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

export type ChatMessageRole = 'user' | 'assistant' | 'system';

/** Any part of a message. The transcript draws text; `renderPart` draws the rest. */
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
 * Clip a still-streaming text at its last completed sentence or paragraph, so
 * under reduced motion whole sentences append and never single words. Nothing
 * paints before the first boundary; the finished turn renders in full.
 */
export function clipAtSentenceBoundary(text: string): string {
  let cut = 0;
  for (const match of text.matchAll(/[.!?](?=\s)|\n/gu)) {
    cut = (match.index ?? 0) + match[0].length;
  }
  return text.slice(0, cut);
}

/**
 * Has this assistant turn painted anything yet? A `step-start` part draws
 * nothing and a text part is empty until its first delta, so "the message has
 * parts" is not "the person can see an answer". Under reduced motion a text part
 * still streaming paints nothing before its first sentence ends. Any other part
 * counts the moment it exists.
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

/** False once the turn around a text has ended. A part's own `state` cannot say
 * so, because a stopped or failed turn can leave it `streaming`, and the person
 * must then see what arrived, in full. */
const TurnLiveContext = createContext(true);

/** One text part as sanitized markdown, memoized on its text. */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  streaming = false,
  literalHtml = false,
  messageId,
  role,
  partIndex,
  annotatable,
  rootRef,
}: {
  text: string;
  /** Still receiving deltas: under reduced motion the paint holds at the last
   * completed sentence. */
  streaming?: boolean;
  /** A person's own message: HTML they typed stays literal text. */
  literalHtml?: boolean;
  /** Where this text sits, as scalars so `memo` short-circuits. A host reads
   * them back off the element to anchor a selection. */
  messageId?: string;
  role?: ChatMessageRole;
  partIndex?: number;
  /** Written as `data-annotatable="true"` or `"false"`, for a host's selection
   * work. Message text cannot write this attribute itself. */
  annotatable?: boolean;
  /** The part's root, for a host painting into its DOM. Keep it stable. The
   * text repaints when it changes, so repaint after that. */
  rootRef?: React.Ref<HTMLDivElement>;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const live = useContext(TurnLiveContext) && streaming;
  const shown = live && reducedMotion ? clipAtSentenceBoundary(text) : text;
  const render = useMemo(() => chatTextRenderer(literalHtml), [literalHtml]);
  const html = useMemo(() => render(shown, live), [render, shown, live]);
  // One `{__html}` object per html string: React re-sets innerHTML whenever
  // that prop's identity changes, which would collapse a live selection.
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

/** One message: its name row, then its parts. */
export function ChatMessageView<Part extends ChatMessagePart = ChatMessagePart>({
  message,
  agentName,
  agentMark,
  userName = 'You',
  userMark,
  stopped = false,
  stoppedLabel = 'Stopped',
  indentContent = false,
  renderPart,
  footer,
}: {
  message: ChatMessage<Part>;
  agentName: string;
  agentMark?: React.ReactNode;
  userName?: string;
  userMark?: React.ReactNode;
  /** This turn's run was cancelled: partial text kept, labelled. */
  stopped?: boolean;
  stoppedLabel?: string;
  /** Indent the parts under the name, past a mark. */
  indentContent?: boolean;
  /** Draw a part. `undefined` falls through: text as markdown, anything else as
   * nothing. `null` draws nothing. */
  renderPart?: (part: Part, context: ChatPartContext<Part>) => React.ReactNode | undefined;
  /** Under the parts. */
  footer?: React.ReactNode;
}) {
  const isUser = message.role === 'user';
  return (
    <div className="flex flex-col gap-1.5" data-message-role={message.role}>
      <div className="flex items-center gap-2 text-xs">
        {isUser ? userMark : agentMark}
        <span className="font-semibold text-foreground">{isUser ? userName : agentName}</span>
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
  /** The conversation, in the order to show it. The host owns its source. */
  readonly messages: readonly ChatMessage<Part>[];
  readonly status: ChatStatus;
  /** The name on the agent's turns. */
  readonly agentName: string;
  /** The face on the agent's turns. */
  readonly agentMark?: React.ReactNode;
  readonly userName?: string;
  /** The face on the person's turns. */
  readonly userMark?: React.ReactNode;
  /** Shown while there are no messages. */
  readonly empty?: React.ReactNode;
  /** One quiet status line at the end. */
  readonly statusLine?: string | null;
  /** The pane's accessible name. */
  readonly label?: string;
  /** With tabs in the header: this pane as the matching tabpanel. */
  readonly panel?: { readonly id: string; readonly labelledBy: string };
  /** Ids of the turns the person stopped. */
  readonly stopped?: ReadonlySet<string>;
  readonly stoppedLabel?: string;
  /** Indent parts under the name, past a mark. */
  readonly indentContent?: boolean;
  /** The line held while the reply has no parts yet. `false` hides it, for a
   * host that says so in `statusLine`. */
  readonly pending?: React.ReactNode | false;
  /** Draw a part. `undefined` falls through to the transcript's own drawing;
   * `null` draws nothing. To paint into a text part, return a `ChatMarkdown` of
   * your own, with the same props the transcript gives its own. */
  readonly renderPart?: (part: Part, context: ChatPartContext<Part>) => React.ReactNode | undefined;
  /** Draw a whole row. `undefined` falls through; `null` draws nothing. */
  readonly renderMessage?: (message: ChatMessage<Part>, index: number) => React.ReactNode | undefined;
  /** Under a message's parts. */
  readonly messageFooter?: (message: ChatMessage<Part>) => React.ReactNode;
  /** The host's handle on the scroll pane, for its own selection work. */
  readonly scrollRef?: React.RefObject<HTMLDivElement | null>;
  /** Positioned in the pane's scroll space, so it rides with the text. */
  readonly overlay?: React.ReactNode;
}

/** The scroll pane and the message list. The host passes what it reads: the
 * messages and the status. */
export function ChatTranscript<Part extends ChatMessagePart = ChatMessagePart>({
  messages,
  status,
  agentName,
  agentMark,
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
}: ChatTranscriptProps<Part>) {
  // `submitted` is set the moment a message is sent, and a stream's start can
  // push an assistant message with no parts without changing the status. The
  // whole blank gap is "a run is active and the answer shows nothing yet".
  const running = status === 'submitted' || status === 'streaming';
  const reducedMotion = usePrefersReducedMotion();
  const lastMessage = messages[messages.length - 1];
  const answerStarted =
    lastMessage !== undefined &&
    lastMessage.role === 'assistant' &&
    chatTurnHasOutput(lastMessage, reducedMotion && running);
  const pending = running && !answerStarted && pendingLine !== false;

  // Follow the output: stick to the live edge, released by scrolling away,
  // re-armed at the edge.
  const ownRef = useRef<HTMLDivElement | null>(null);
  const paneRef = scrollRef ?? ownRef;
  const atBottomRef = useRef(true);
  useEffect(() => {
    const node = paneRef.current;
    if (node !== null && atBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [messages, statusLine, pending, paneRef]);
  // The pane also follows when its own box shrinks (a growing composer).
  useEffect(() => {
    const node = paneRef.current;
    if (node === null || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [paneRef]);

  // An assistant turn that has painted nothing yet would be a bare name row,
  // so it is dropped and the pending turn stands in its place.
  const drawn = (message: ChatMessage<Part>, live: boolean): boolean =>
    message.role === 'user' ||
    (message.role === 'assistant' && chatTurnHasOutput(message, reducedMotion && live));

  return (
    <div
      ref={paneRef}
      onScroll={(event) => {
        const node = event.currentTarget;
        atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}
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
            // Only the last message can still be arriving.
            const live = running && index === messages.length - 1;
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
}
