import { useCallback, useEffect, useRef, useState } from 'react';
import { markAutoViewedNoticeSeen, needsAutoViewedNotice, turnOffAutoViewed } from '../utils/autoViewedNotice';

export type AutoViewedNoticeState = 'intro' | 'off' | null;

export function useAutoViewedNotice({ blocked, fileKey }: { blocked: boolean; fileKey: unknown }) {
  const [notice, setNotice] = useState<AutoViewedNoticeState>(null);
  const shownFor = useRef<{ key: unknown } | null>(null);

  const show = useCallback(() => {
    if (blocked || !needsAutoViewedNotice()) return;
    markAutoViewedNoticeSeen();
    shownFor.current = null;
    setNotice('intro');
  }, [blocked]);

  const turnOff = useCallback(() => {
    turnOffAutoViewed();
    setNotice('off');
  }, []);

  useEffect(() => {
    if (!notice) return;
    if (!shownFor.current) shownFor.current = { key: fileKey };
    else if (shownFor.current.key !== fileKey) setNotice(null);
  }, [fileKey, notice]);

  return { notice, show, turnOff };
}
