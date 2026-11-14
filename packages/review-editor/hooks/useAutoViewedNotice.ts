import { useCallback, useEffect, useRef, useState } from 'react';
import { markAutoViewedNoticeSeen, needsAutoViewedNotice, turnOffAutoViewed } from '../utils/autoViewedNotice';

export type AutoViewedNoticeState = 'intro' | 'off' | null;

export const AUTO_VIEWED_NOTICE_SETTLE_MS = 1500;

export function useAutoViewedNotice({ blocked, fileKey, now = Date.now }: { blocked: boolean; fileKey: unknown; now?: () => number }) {
  const [notice, setNotice] = useState<AutoViewedNoticeState>(null);
  const shown = useRef<{ key: unknown; at: number } | null>(null);

  const show = useCallback(() => {
    if (blocked || !needsAutoViewedNotice()) return;
    markAutoViewedNoticeSeen();
    shown.current = null;
    setNotice('intro');
  }, [blocked]);

  const turnOff = useCallback(() => {
    turnOffAutoViewed();
    setNotice('off');
  }, []);

  useEffect(() => {
    if (!notice) return;
    const current = shown.current;
    if (!current || now() - current.at < AUTO_VIEWED_NOTICE_SETTLE_MS) {
      shown.current = { key: fileKey, at: current?.at ?? now() };
      return;
    }
    if (current.key !== fileKey) setNotice(null);
  }, [fileKey, notice, now]);

  return { notice, show, turnOff };
}
