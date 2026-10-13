import React from 'react';
import { useServerSessionReplaced } from '../utils/serverSession';

/**
 * The stale-tab prompt (packages/ui/utils/serverSession.ts): shown once a
 * decision was refused with `409 session_mismatch`, i.e. the Plannotator
 * session this tab was opened for is gone and a newer one owns the address.
 * Nothing was submitted; reloading shows what is open there now.
 */
export const ServerSessionReplacedBanner: React.FC<{ onReload?: () => void }> = ({ onReload }) => {
  const replaced = useServerSessionReplaced();
  if (!replaced) return null;
  return (
    <div
      role="alert"
      data-server-session-replaced
      className="fixed inset-x-0 top-0 z-[110] flex items-center justify-center gap-3 border-b border-border bg-destructive/95 px-4 py-2 text-sm text-destructive-foreground shadow-md"
    >
      <span>This review was replaced — reload to see what is open now. Nothing was submitted.</span>
      <button
        type="button"
        onClick={onReload ?? (() => window.location.reload())}
        className="rounded border border-destructive-foreground/40 px-2 py-0.5 font-medium hover:bg-destructive-foreground/10"
      >
        Reload
      </button>
    </div>
  );
};
