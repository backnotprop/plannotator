import type { InboxDraft } from '@plannotator/core/inbox-types';

export interface ComposeSent {
  threadId: string;
  session: string;
  host: string;
  projectName: string;
  draftId: string | null;
  cardId?: string | null;
  launched?: boolean;
  pullKeys?: readonly string[] | null;
  machine?: string | null;
  pullAsk?: 'guide' | 'custom' | null;
}

export interface ComposeHeld {
  key: string;
  queued: boolean;
  machineName: string;
  asleep: boolean;
  agentName: string;
  first?: string;
  draftId: string | null;
  words: { body: string; thread_name?: string; card?: InboxDraft['card']; pulls?: InboxDraft['pulls']; board_request?: true };
}

export interface ComposeJoined {
  threadId: string;
  threadName: string;
  agent: string;
  draftId: string | null;
}
