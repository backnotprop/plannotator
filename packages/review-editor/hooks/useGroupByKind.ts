import { useCallback, useState } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

/**
 * The Tree controls' "Group by kind" switch (approved design record
 * "review-file-kinds"): on by default, remembered in a cookie when turned off.
 * Cookie-only on purpose, like `plannotator-markdown-view`: the settings
 * registry is bundled into the pinned guides.show viewer, so a registry entry
 * would change that build for a review-only preference.
 */
export const GROUP_BY_KIND_COOKIE = 'plannotator-review-group-by-kind';

export function readGroupByKind(): boolean {
  return storage.getItem(GROUP_BY_KIND_COOKIE) !== 'off';
}

export function useGroupByKind(): [boolean, () => void] {
  const [on, setOn] = useState(readGroupByKind);
  const toggle = useCallback(() => {
    const next = !on;
    // The default (on) is the absence of the cookie.
    if (next) storage.removeItem(GROUP_BY_KIND_COOKIE);
    else storage.setItem(GROUP_BY_KIND_COOKIE, 'off');
    setOn(next);
  }, [on]);
  return [on, toggle];
}
