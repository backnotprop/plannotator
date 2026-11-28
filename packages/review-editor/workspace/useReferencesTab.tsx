import React, { useCallback, useMemo, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { ReviewCodeNavPanel } from '../dock/panels/ReviewCodeNavPanel';
import type { ReviewSidebarExtraTab } from '../components/ReviewSidebar';

export const REFERENCES_TAB_ID = 'references';

/** `hide`: the tab goes without closing the sidebar (a click's References that jumped to the one definition). */
export function useReferencesTab(onClose: () => void): { tab: ReviewSidebarExtraTab | null; show: () => void; hide: () => void } {
  const [shown, setShown] = useState(false);
  const tab = useMemo<ReviewSidebarExtraTab | null>(() => {
    if (!shown) return null;
    const props = {
      api: { id: REFERENCES_TAB_ID, close: () => { setShown(false); onClose(); } },
      params: {},
    } as unknown as IDockviewPanelProps;
    return { id: REFERENCES_TAB_ID, label: 'References', render: () => <ReviewCodeNavPanel {...props} /> };
  }, [shown, onClose]);
  const show = useCallback(() => setShown(true), []);
  const hide = useCallback(() => setShown(false), []);
  return { tab, show, hide };
}
