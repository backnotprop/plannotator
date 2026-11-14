import type { InboxDraft } from '@plannotator/core/inbox-types';
import { inboxApi } from './api';
import type { ComposeRequest } from './compose/ComposeDialog';

export function openTakenBack(draft: InboxDraft, openCompose: (request: ComposeRequest) => void, afterWrite: () => Promise<void>): void {
  void inboxApi.drafts().then((model) => openCompose({ draft: model.drafts.find((d) => d.id === draft.id) ?? { ...draft, status: 'none' } }));
  void afterWrite();
}
