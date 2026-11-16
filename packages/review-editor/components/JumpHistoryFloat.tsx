import React, { useLayoutEffect, useRef } from 'react';
import { formatShortcutBindingText, getShortcutPlatform, resolveShortcutBindings, reviewExplorerShortcuts } from '@plannotator/ui/shortcuts';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import { navLocationLabel, type JumpCrumb, type NavLocation } from '../utils/explorerNavigation';

const keyHint = (action: 'navigateBack' | 'navigateForward') => {
  const binding = resolveShortcutBindings(reviewExplorerShortcuts.shortcuts[action])[0];
  return binding ? ` (${formatShortcutBindingText(binding, getShortcutPlatform())})` : '';
};

const VIA: Record<JumpCrumb['via'], string> = {
  definition: 'Go to Definition',
  references: 'References',
  file: 'Go to File',
};

const samePlace = (a: NavLocation, b: NavLocation) => a.path === b.path && (a.line ?? null) === (b.line ?? null);

function backLabel(to: NavLocation | null | undefined, crumb: JumpCrumb | null | undefined): string {
  if (!to) return 'Go back';
  const via = crumb && samePlace(crumb.from, to) ? ` · ${VIA[crumb.via]}` : '';
  return `Back to ${navLocationLabel(to)}${via}`;
}

function forwardLabel(to: NavLocation | null | undefined): string {
  return to ? `Forward to ${navLocationLabel(to)}` : 'Go forward';
}

const Chevron: React.FC<{ d: string }> = ({ d }) => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path d={d} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const JumpHistoryFloat: React.FC<{ active: boolean; focusHome?: () => HTMLElement | null }> = ({ active, focusHome }) => {
  const state = useReviewStateOptional();
  const navigation = state?.navigation;
  const shown = active && !!navigation && (navigation.canBack || navigation.canForward);
  const hadFocus = useRef(false);

  useLayoutEffect(() => {
    if (shown || !hadFocus.current) return;
    hadFocus.current = false;
    if (!active) return;
    const current = document.activeElement;
    if (!current || current === document.body || !current.isConnected) focusHome?.()?.focus({ preventScroll: true });
  }, [shown, active, focusHome]);

  if (!shown || !navigation) return null;
  const compact = !!state?.isCompactTouchLayout;
  const size = compact ? 'h-11 w-11' : 'h-7 w-7';
  const button = `${size} flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-muted aria-disabled:opacity-40 aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`;
  const back = backLabel(navigation.backTo, state?.jumpCrumb);
  const forward = forwardLabel(navigation.forwardTo);

  return (
    <div
      role="group"
      aria-label="Jump history"
      data-jump-float=""
      className="absolute z-10 flex items-center gap-0.5 p-0.5 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg motion-safe:animate-[fade-in_150ms_ease-out]"
      style={compact
        ? { right: 12, bottom: 'calc(12px + var(--pn-safe-bottom, 0px))' }
        : { right: 44, bottom: 14 }}
      onMouseDown={(event) => event.preventDefault()}
      onFocus={() => { hadFocus.current = true; }}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) hadFocus.current = false;
      }}
    >
      <button
        type="button"
        className={button}
        aria-disabled={!navigation.canBack || undefined}
        aria-label={back}
        title={`${back}${keyHint('navigateBack')}`}
        onClick={() => { if (navigation.canBack) navigation.back(); }}
        data-jump-float-back=""
      >
        <Chevron d="M15 18l-6-6 6-6" />
      </button>
      <button
        type="button"
        className={button}
        aria-disabled={!navigation.canForward || undefined}
        aria-label={forward}
        title={`${forward}${keyHint('navigateForward')}`}
        onClick={() => { if (navigation.canForward) navigation.forward(); }}
        data-jump-float-forward=""
      >
        <Chevron d="M9 18l6-6-6-6" />
      </button>
    </div>
  );
};
