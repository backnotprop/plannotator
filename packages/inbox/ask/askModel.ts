/**
 * What the Ask AI window draws, worked out from what it read. Pure.
 *
 * The chat list (approval "inbox-ask-ai-flow", Header 2026-11-02): the top
 * group is the current chat, anything answering or with a new answer, and chats
 * from the last 24 hours. Older chats go under "Recent", at most 20.
 *
 * The transcript: the saved file wins, and the stream only fills in the turn
 * still being answered, so a window that slept or lost its stream shows what
 * the Inbox kept.
 */
import type { ChatMessage, ChatTextPart } from '@plannotator/ui/components/chat';
import type { InboxAskChat, InboxAskConversationWire, InboxAskTurnWire } from '../api';

export const ASK_RECENT_MAX = 20;
const ASK_TOP_MS = 24 * 60 * 60 * 1000;

export interface AskChatGroups {
  top: InboxAskChat[];
  recent: InboxAskChat[];
}

/** The rows of the dropdown. `current` is drawn first even with no question yet: it is the chat on screen. */
export function askChatGroups(chats: readonly InboxAskChat[], current: InboxAskChat, now: number): AskChatGroups {
  const others = chats.filter((chat) => chat.thread_id !== current.thread_id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const inTop = (chat: InboxAskChat) => chat.answering || chat.unread || now - Date.parse(chat.at) < ASK_TOP_MS;
  return {
    top: [chats.find((chat) => chat.thread_id === current.thread_id) ?? current, ...others.filter(inTop)],
    recent: others.filter((chat) => !inTop(chat)).slice(0, ASK_RECENT_MAX),
  };
}

/** A chat's time in a row: "4 min ago", "1 h ago", "2 days ago", "last week". */
export function askChatTime(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const askChatName = (subject: string | null): string => subject ?? '(no subject)';

/** The turn still arriving in this window, with what its stream brought so far. */
export interface AskLiveText {
  turnId: string;
  text: string;
  streaming: boolean;
}

export const askUserId = (turnId: string): string => `q-${turnId}`;
export const askAnswerId = (turnId: string): string => `a-${turnId}`;

/** The conversation as transcript messages. A turn with no words has no answer row: the transcript's pending line or a note stands there. */
export function askMessages(conversation: InboxAskConversationWire | null, live: AskLiveText | null): ChatMessage<ChatTextPart>[] {
  const messages: ChatMessage<ChatTextPart>[] = [];
  for (const turn of conversation?.turns ?? []) {
    messages.push({ id: askUserId(turn.id), role: 'user', parts: [{ type: 'text', text: turn.question }] });
    const streamed = live?.turnId === turn.id && turn.answer === undefined ? live : null;
    const text = turn.answer ?? streamed?.text ?? '';
    if (text) messages.push({ id: askAnswerId(turn.id), role: 'assistant', parts: [{ type: 'text', text, state: streamed?.streaming ? 'streaming' : 'done' }] });
  }
  return messages;
}

/** The ids the transcript labels Stopped. */
export function askStopped(conversation: InboxAskConversationWire | null): ReadonlySet<string> {
  return new Set((conversation?.turns ?? []).filter((turn) => turn.stopped && turn.answer).map((turn) => askAnswerId(turn.id)));
}

/** The note under a turn the file says did not end well, or null. */
export function askTurnNote(turn: InboxAskTurnWire, agent: string): string | null {
  if (turn.failure === 'gone') return `${agent} went away before it finished.`;
  if (turn.failure === 'taken_over') return 'Another message took over the session, so this answer stops here.';
  if (turn.failure === 'failed') return `${agent} could not finish this answer.`;
  return null;
}

/** The turn asked with no answer and nothing running: what the person can do about it. */
export function askUnanswered(turn: InboxAskTurnWire, running: string | null): boolean {
  return turn.answer === undefined && !turn.stopped && turn.id !== running;
}

/** The newest answer's time, what `seen` reports. */
export function askNewestAnswer(conversation: InboxAskConversationWire | null): string | null {
  let newest: string | null = null;
  for (const turn of conversation?.turns ?? []) {
    if (turn.answered_at && (newest === null || Date.parse(turn.answered_at) > Date.parse(newest))) newest = turn.answered_at;
  }
  return newest;
}

/** Whether the window has answers its `seen_at` does not cover. */
export function askUnseen(conversation: InboxAskConversationWire | null): string | null {
  const newest = askNewestAnswer(conversation);
  if (!newest) return null;
  const seen = conversation?.seen_at ?? null;
  return seen === null || Date.parse(newest) > Date.parse(seen) ? newest : null;
}
