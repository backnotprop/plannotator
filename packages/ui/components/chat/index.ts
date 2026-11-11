/**
 * A shared floating chat window: screen code only. The classes below are not in `theme.css`, so
 * a host defines them in its own `@theme`.
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
  followPointer,
  isOnTitleRow,
  startsGesture,
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
  type ChatPartContext,
  type ChatStatus,
  type ChatTextPart,
  type ChatTranscriptProps,
} from './ChatTranscript';
export { chatMarkdownHtml, personMarkdownHtml, richMarkdownHtml } from './chatMarkdown';
export { FOCUS_RING, floatingDialogChrome } from './chatRecipes';
