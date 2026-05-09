import React from 'react';

export function PRSwitchOverlay() {
  return (
    <div className="pr-switch-overlay fixed inset-0 z-[100] flex items-center justify-center bg-background/60">
      <div className="pr-switch-shimmer absolute top-0 left-0 right-0" />
      <div className="pr-switch-grid">
        <span /><span /><span /><span /><span /><span /><span /><span /><span />
      </div>
    </div>
  );
}
