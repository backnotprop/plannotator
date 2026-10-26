/**
 * The dot on the sidebar toggle while the sidebar is closed (the owner,
 * 2026-10-24: "Yes, add the dot"): the Update button lives in the sidebar's
 * foot, so a closed sidebar hid it. It follows what that button invites:
 * Available and Ready in the primary colour, Failed in a neutral tone (the
 * button's rule: never the error colour). Updating and Restarting are in
 * progress and invite nothing; no update (up to date, snoozed, a page opened
 * over the tailnet) is no dot.
 */
import type { InboxHealth } from '@plannotator/core/inbox-types';
import type { SidebarToggleNotice } from './shell/sidebar';

type InboxUpdate = InboxHealth['update'];
type UpdateState = NonNullable<InboxHealth['update']>['state'];

export function sidebarUpdateNotice(state: UpdateState | null | undefined, restarting: boolean, checkFailing = false): SidebarToggleNotice | null {
  if (restarting) return null;
  // Checking has failed for hours: the quiet "Can't check for updates" row is in the sidebar too (neutral, like Failed).
  if (!state) return checkFailing ? { tone: 'neutral', label: "can't check for updates" } : null;
  switch (state) {
    case 'available':
      return { tone: 'primary', label: 'update available' };
    case 'ready':
      return { tone: 'primary', label: 'update ready' };
    case 'failed':
      return { tone: 'neutral', label: 'update failed' };
    default:
      return null;
  }
}

/**
 * The update this page may offer: none on a page opened over the tailnet,
 * where every /api/inbox/update* route answers 403 local_only (the server
 * still carries `update` in the list model, health and status frames,
 * whatever listener served them), and none until the settings read says
 * which listener this page came through (the rule the sidebar's
 * "Reload Claude Code N" follows). It gates the sidebar's Update button,
 * the toggle's dot and Settings → About's update.
 */
export function updateForPage(update: InboxUpdate, settings: { via?: 'local' | 'tailnet' } | null): InboxUpdate {
  return pageOffersUpdates(settings) ? update : null;
}

/**
 * Whether this page may offer anything about updating (the Update button, the
 * dot, Settings → General's update row, "Can't check for updates"): only once
 * the settings read says it came through this computer, never over the tailnet.
 */
export function pageOffersUpdates(settings: { via?: 'local' | 'tailnet' } | null): boolean {
  return !!settings && settings.via !== 'tailnet';
}
