import type { InboxQuestion } from '@plannotator/core/inbox-types';
import { apiPost } from '../api';
import { hasMachineMark, inboxUrl, machineOf } from '../inboxUrl';

export const reopenAnswered = (messageId: string, key: string) =>
  apiPost<{ questions: InboxQuestion[] }>(inboxUrl(`/messages/${encodeURIComponent(messageId)}/reopen`, undefined, machineOf(messageId)), { key });

export const reopensAnswered = (messageId: string): boolean => hasMachineMark(machineOf(messageId), 'answered-in-reply');
