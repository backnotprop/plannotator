import type { InboxQuestion } from '@plannotator/core/inbox-types';
import { apiPost } from '../api';
import { inboxUrl, machineOf } from '../inboxUrl';

export const reopenAnswered = (messageId: string, key: string) =>
  apiPost<{ questions: InboxQuestion[] }>(inboxUrl(`/messages/${encodeURIComponent(messageId)}/reopen`, undefined, machineOf(messageId)), { key });
