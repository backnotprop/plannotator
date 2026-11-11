/** The thread's name as a chip unless the subject already starts with it, where the name ends as the subject's words do: `search` still shows beside "Searchable…". */

import { inboxThreadNameKey } from '@plannotator/core/inbox-types';

export function threadChipName(threadName: string | null | undefined, subject: string): string | null {
  if (!threadName) return null;
  const name = inboxThreadNameKey(threadName);
  const words = inboxThreadNameKey(subject);
  if (name && words.startsWith(name) && /^(?:$|\s|[:\-–—]\s)/u.test(words.slice(name.length))) return null;
  return threadName;
}
