import { useCallback, useState } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

export const GROUP_BY_KIND_COOKIE = 'plannotator-review-group-by-kind';

export function readGroupByKind(): boolean {
  return storage.getItem(GROUP_BY_KIND_COOKIE) !== 'off';
}

export function useGroupByKind(): [boolean, () => void] {
  const [on, setOn] = useState(readGroupByKind);
  const toggle = useCallback(() => {
    const next = !on;
    if (next) storage.removeItem(GROUP_BY_KIND_COOKIE);
    else storage.setItem(GROUP_BY_KIND_COOKIE, 'off');
    setOn(next);
  }, [on]);
  return [on, toggle];
}
