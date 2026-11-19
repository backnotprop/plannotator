import { useCallback, useState } from 'react';
import { parseInboxOnSetting, saveInboxOnSetting } from '../utils/inboxOnSetting';

export interface InboxOnSettingState {
  /** Undefined: no row (the Inbox was not on when the page loaded, or an older server). */
  readonly on: boolean | undefined;
  /** What the server said after the last change (after off: how to turn it back on). */
  readonly line: string | undefined;
  /** Takes `inboxOn` from a `/api/plan` or `/api/diff` serverConfig (only once: the row stays after a change). */
  readonly adopt: (serverConfig: unknown) => void;
  /** Turns the Inbox off or on; rejects with a readable Error when nothing changed. */
  readonly save: (on: boolean) => Promise<void>;
}

/** Settings' Plannotator Inbox row for an App (utils/inboxOnSetting.ts). */
export function useInboxOnSetting(): InboxOnSettingState {
  const [on, setOn] = useState<boolean | undefined>(undefined);
  const [line, setLine] = useState<string | undefined>(undefined);
  const adopt = useCallback((serverConfig: unknown) => {
    const reported = parseInboxOnSetting(serverConfig);
    setOn((current) => current ?? reported);
  }, []);
  const save = useCallback(async (next: boolean) => {
    const said = await saveInboxOnSetting(next);
    setOn(next);
    setLine(said);
  }, []);
  return { on, line, adopt, save };
}
