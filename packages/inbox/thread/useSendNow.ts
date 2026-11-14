import { useState } from 'react';
import { InboxApiError, inboxApi } from '../api';

const NOT_SENT = 'It was not sent now. Try again.';

export function useSendNow(lastId: string, changed: () => Promise<void>, reloadLive: () => unknown, reloadTags: () => unknown) {
  const [sendNowState, setSendNowState] = useState<{ id: string; busy: boolean; error: string | null } | null>(null);
  const [tagSendNow, setTagSendNow] = useState<{ id: string; session: string; busy: boolean; error: string | null } | null>(null);
  const sendNow = async () => {
    setSendNowState({ id: lastId, busy: true, error: null });
    try {
      await inboxApi.sendNow(lastId);
      setSendNowState({ id: lastId, busy: false, error: null });
      await changed();
    } catch (cause) {
      setSendNowState({ id: lastId, busy: false, error: cause instanceof InboxApiError ? cause.message : NOT_SENT });
    }
    void reloadLive();
  };
  const sendTagNow = async (session: string) => {
    setTagSendNow({ id: lastId, session, busy: true, error: null });
    try {
      await inboxApi.sendNow(lastId, session);
      setTagSendNow({ id: lastId, session, busy: false, error: null });
      await changed();
    } catch (cause) {
      setTagSendNow({ id: lastId, session, busy: false, error: cause instanceof InboxApiError ? cause.message : NOT_SENT });
    }
    void reloadTags();
  };
  const sendNowError = sendNowState?.id === lastId ? sendNowState.error : null;
  return { sendNowState, sendNow, sendNowError, tagSendNow, sendTagNow };
}
