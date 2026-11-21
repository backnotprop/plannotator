import type { SettingsModel } from '../api';

/**
 * Whether the window shows anything of System (approval "system-inbox"): only while System is on, and System only
 * while Code review is on. Every System surface reads this one helper, so Settings → Capabilities' switch (step B1)
 * changes what it reads here and nowhere else. Off by default: an Inbox that sends no `system` is off.
 */
export function systemShown(settings: Pick<SettingsModel, 'code_review' | 'system'> | null | undefined): boolean {
  return settings?.code_review?.on === true && settings?.system?.on === true;
}
