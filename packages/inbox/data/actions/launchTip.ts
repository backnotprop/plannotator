import { useMemo, useRef } from 'react';
import { claimRevealOnce } from '../../reveal';

/**
 * The Launch tip's claim (compose/launchTip.ts), moved out of App.tsx: this page spends it once, with its own key (a
 * retry after a lost answer is shown it again); the Inbox keeps it seen for every window and the phone. `spent`: this
 * page has claimed it.
 */
export function useLaunchTipClaim() {
  const spent = useRef(false);
  const key = useRef(`lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const tip = useMemo(
    () => ({
      claim: async () => {
        spent.current = true;
        return (await claimRevealOnce('launch_tip', key.current)).show;
      },
    }),
    [],
  );
  return { spent, tip };
}
