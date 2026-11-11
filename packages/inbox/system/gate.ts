import type { SettingsModel } from '../api';

export function systemShown(settings: Pick<SettingsModel, 'code_review' | 'system'> | null | undefined): boolean {
  return settings?.code_review?.on === true && settings?.system?.on === true;
}
