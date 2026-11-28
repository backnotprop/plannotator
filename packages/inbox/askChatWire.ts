/** One row of the chat list (`GET /api/inbox/ask`). */
export interface InboxAskChat {
  thread_id: string;
  subject: string | null;
  project: string;
  host: string | null;
  /** When anything last happened in the chat. */
  at: string;
  unread: boolean;
  answering: boolean;
}
