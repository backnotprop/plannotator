import { useCallback, useEffect, useState } from 'react';
import { configStore } from '../config';
import {
  markLookAndFeelChoiceResolved,
  planLookAnsweredElsewhere,
  planLookPrompt,
  type PlanLookPrompt,
} from '../utils/lookAndFeelAnnouncement';

export interface PlanLookDialog {
  /** Which dialog this page load shows: the first-run chooser, the one-time "moved to Clean" notice, or none. Read once per page load. */
  prompt: PlanLookPrompt;
  open: boolean;
  /** Continue or Escape: record `gridEnabled` as the choice, unless another tab answered first. */
  dismiss: () => void;
}

/**
 * The plan-look chooser and notice, shared by the plan editor and the code
 * review app. The cookie marker is shared, so answering in either app
 * resolves it everywhere.
 *
 * The first answer wins: two open tabs both show the dialog, and when one is
 * answered the other adopts that look and writes nothing, so its preselected
 * Clean can never overwrite a Grid picked in the first tab. That happens on
 * dismiss, and also when the person comes back to the tab (visibilitychange
 * or focus) while the dialog is still open.
 */
export function usePlanLookDialog(gridEnabled: boolean): PlanLookDialog {
  const [prompt] = useState(planLookPrompt);
  const [open, setOpen] = useState(prompt !== null);

  const adopt = useCallback((grid: boolean) => {
    configStore.seed('gridEnabled', grid);
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const grid = planLookAnsweredElsewhere();
      if (grid !== null) adopt(grid);
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [open, adopt]);

  const dismiss = useCallback(() => {
    const answered = planLookAnsweredElsewhere();
    if (answered !== null) {
      adopt(answered);
      return;
    }
    // Persist even when the user accepts the displayed default without first
    // clicking its already-selected card, then record the explicit decision.
    configStore.set('gridEnabled', gridEnabled);
    markLookAndFeelChoiceResolved();
    setOpen(false);
  }, [gridEnabled, adopt]);

  return { prompt, open, dismiss };
}
