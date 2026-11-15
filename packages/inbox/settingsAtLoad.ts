import { inboxApi, type SettingsModel } from './api';

let atLoad: Promise<SettingsModel> | null = null;

export function readSettingsAtLoad(): void {
  atLoad = inboxApi.settings();
  atLoad.catch(() => {});
}

export function settingsReadAtLoad(): boolean {
  return atLoad !== null;
}

export function takeSettingsAtLoad(): Promise<SettingsModel> | null {
  const answer = atLoad;
  atLoad = null;
  return answer;
}

export function sameSettings(a: SettingsModel, b: SettingsModel): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
