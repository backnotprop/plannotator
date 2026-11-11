import { useCallback, useEffect, useState } from 'react';
import { configStore } from '../config';
import {
  markLookAndFeelChoiceResolved,
  planLookAnsweredElsewhere,
  planLookPrompt,
  type PlanLookPrompt,
} from '../utils/lookAndFeelAnnouncement';

export interface PlanLookDialog {
  prompt: PlanLookPrompt;
  open: boolean;
  dismiss: () => void;
}

/** The cookie marker is shared, so answering in either app resolves it everywhere. */
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
    configStore.set('gridEnabled', gridEnabled);
    markLookAndFeelChoiceResolved();
    setOpen(false);
  }, [gridEnabled, adopt]);

  return { prompt, open, dismiss };
}
