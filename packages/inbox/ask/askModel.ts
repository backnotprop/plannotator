import type { ChatMessage, ChatTextPart } from '@plannotator/ui/components/chat';
import { inboxReviewLines } from '@plannotator/core/inbox-review';
import type { InboxAskChat, InboxAskConversationWire, InboxAskTurnWire } from '../api';

export const ASK_RECENT_MAX = 20;
const ASK_TOP_MS = 24 * 60 * 60 * 1000;

export interface AskChatGroups {
  top: InboxAskChat[];
  recent: InboxAskChat[];
}

export function askChatGroups(chats: readonly InboxAskChat[], current: InboxAskChat, now: number): AskChatGroups {
  const others = chats.filter((chat) => chat.thread_id !== current.thread_id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const inTop = (chat: InboxAskChat) => chat.answering || chat.unread || now - Date.parse(chat.at) < ASK_TOP_MS;
  return {
    top: [chats.find((chat) => chat.thread_id === current.thread_id) ?? current, ...others.filter(inTop)],
    recent: others.filter((chat) => !inTop(chat)).slice(0, ASK_RECENT_MAX),
  };
}

export function askRowState(chat: InboxAskChat, currentId: string): 'current' | 'answering' | 'unread' | null {
  if (chat.thread_id === currentId) return 'current';
  return chat.answering ? 'answering' : chat.unread ? 'unread' : null;
}

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

export interface AskLiveText {
  turnId: string;
  text: string;
  streaming: boolean;
}

export function askShownQuestion(turn: Pick<InboxAskTurnWire, 'question' | 'kind' | 'show_me'>): string {
  if (turn.kind !== 'show_me' || !turn.show_me) return turn.question;
  const { file, lines, words, part } = turn.show_me;
  if (part) return `Show me on ${part.name}${words?.trim() ? `: ${words.trim()}` : ''}`;
  const where = file ? `${file.slice(file.lastIndexOf('/') + 1)}${lines ? ` ${lines[0] === lines[1] ? 'line' : 'lines'} ${inboxReviewLines(lines)}` : ''}` : 'the whole review';
  return `Show me on ${where}${words?.trim() ? `: ${words.trim()}` : ''}`;
}

export const askUserId = (turnId: string): string => `q-${turnId}`;
export const askAnswerId = (turnId: string): string => `a-${turnId}`;

export function askMessages(conversation: InboxAskConversationWire | null, live: AskLiveText | null): ChatMessage<ChatTextPart>[] {
  const messages: ChatMessage<ChatTextPart>[] = [];
  for (const turn of conversation?.turns ?? []) {
    messages.push({ id: askUserId(turn.id), role: 'user', parts: [{ type: 'text', text: askShownQuestion(turn) }] });
    const streamed = live?.turnId === turn.id && turn.answer === undefined ? live : null;
    const text = turn.answer ?? streamed?.text ?? '';
    if (text) messages.push({ id: askAnswerId(turn.id), role: 'assistant', parts: [{ type: 'text', text, state: streamed?.streaming ? 'streaming' : 'done' }] });
  }
  return messages;
}

export function askStopped(conversation: InboxAskConversationWire | null): ReadonlySet<string> {
  return new Set((conversation?.turns ?? []).filter((turn) => turn.stopped && turn.answer).map((turn) => askAnswerId(turn.id)));
}

export function askTurnNote(turn: InboxAskTurnWire, agent: string): string | null {
  if (turn.failure === 'gone') return `${agent} went away before it finished.`;
  if (turn.failure === 'taken_over') return 'Another message took over the session, so this answer stops here.';
  if (turn.failure === 'failed') return `${agent} could not finish this answer.`;
  return null;
}

export function askUnanswered(turn: InboxAskTurnWire, running: string | null): boolean {
  return turn.answer === undefined && !turn.stopped && turn.id !== running;
}

export function askNewestAnswer(conversation: InboxAskConversationWire | null): string | null {
  let newest: string | null = null;
  for (const turn of conversation?.turns ?? []) {
    if (turn.answered_at && (newest === null || Date.parse(turn.answered_at) > Date.parse(newest))) newest = turn.answered_at;
  }
  return newest;
}

export function askUnseen(conversation: InboxAskConversationWire | null): string | null {
  const newest = askNewestAnswer(conversation);
  if (!newest) return null;
  const seen = conversation?.seen_at ?? null;
  return seen === null || Date.parse(newest) > Date.parse(seen) ? newest : null;
}
