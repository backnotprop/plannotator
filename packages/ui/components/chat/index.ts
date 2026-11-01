/**
 * A shared floating chat window: screen code only. The host owns the
 * conversation, the transport and anything saved.
 *
 *   const store = new ChatWindowStore({ initialGeometry, onGeometryChange });
 *   <div className="relative">
 *     <ChatFrame store={store} label="Chat" header={...} onClose={...}>
 *       {() => (
 *         <>
 *           <ChatTranscript messages={messages} status={status} agentName="Agent" />
 *           <ChatComposer value={value} onChange={setValue} onSend={send} />
 *         </>
 *       )}
 *     </ChatFrame>
 *   </div>
 *
 * THEME TOKENS. The classes below are not in `theme.css`, so a host defines
 * them in its own `@theme`. With none defined a class has no rule and the
 * property falls through to its default.
 *
 *   --color-tertiary               text-tertiary, the ink a step behind muted
 *   --color-surface-hover          bg-surface-hover, the quiet hover wash
 *   --color-ring-soft              ring-ring-soft, the focus halo
 *   --color-border-subtle          border-border-subtle, a blockquote's rule
 *   --color-soft-quiet-fill        bg-soft-quiet-fill, Stop's resting fill
 *   --color-soft-quiet-fill-hover  bg-soft-quiet-fill-hover, Stop's hover
 *   --radius-dialog                rounded-dialog, the window's corner
 *   --shadow-dialog                shadow-dialog, the window's shadow
 *   --text-2xs                     text-2xs, the Stopped badge
 *
 * Everything else comes from `theme.css`: bg-card, bg-popover,
 * text-popover-foreground, text-foreground, text-muted-foreground, bg-muted,
 * text-primary, border-border, border-input, ring-ring.
 */

export {
  CHAT_WINDOW_DEFAULT,
  CHAT_WINDOW_FRAME_MARGIN,
  CHAT_WINDOW_MIN,
  ChatWindowStore,
  type ChatWindowGeometry,
  type ChatWindowStoreOptions,
} from './chatWindowStore';
export {
  CHAT_LAUNCHER_SELECTOR,
  ChatFrame,
  ChatFrameLauncher,
  useChatFrameFocusReturn,
  useChatFrameKeys,
  type ChatFrameLabels,
  type ChatFrameProps,
  type ChatFrameRootProps,
  type ChatFrameState,
} from './ChatFrame';
export { CHAT_COMPOSER_FIELD_BOX, ChatComposer, type ChatComposerProps } from './ChatComposer';
export {
  ChatMarkdown,
  ChatMessageView,
  ChatPendingTurn,
  ChatTranscript,
  chatTurnHasOutput,
  clipAtSentenceBoundary,
  type ChatMessage,
  type ChatMessagePart,
  type ChatMessageRole,
  type ChatStatus,
  type ChatTextPart,
  type ChatTranscriptProps,
} from './ChatTranscript';
export { chatMarkdownHtml, personMarkdownHtml } from './chatMarkdown';
export { FOCUS_RING, floatingDialogChrome } from './chatRecipes';
