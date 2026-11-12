export const SETTINGS_SECTIONS = ['general', 'rows', 'agents', 'prompts', 'devices', 'machines', 'accounts', 'voice', 'capabilities', 'activity', 'archived', 'storage', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_SECTION_LABEL: Record<SettingsSection, string> = {
  general: 'General',
  rows: 'Rows',
  agents: 'Agents',
  accounts: 'Accounts',
  prompts: 'Prompts',
  devices: 'Devices',
  machines: 'Machines',
  voice: 'Voice',
  archived: 'Archived',
  storage: 'Storage',
  about: 'About',
  capabilities: 'Capabilities',
  activity: 'Activity',
};

export interface SettingsAddress {
  section: SettingsSection | null;
  pair: boolean;
  experimental?: boolean;
}

const MOVED_SECTIONS: Record<string, SettingsSection> = { 'decision-data': 'activity' };

function isSection(value: string | undefined): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? '');
}

export function parseSettingsHash(hash: string): SettingsAddress | null {
  const parts = hash.split('/');
  if (parts[0] !== 'settings') return null;
  if (parts[1] === 'experimental') return { section: 'capabilities', pair: false, experimental: true };
  const moved = parts[1] !== undefined && Object.hasOwn(MOVED_SECTIONS, parts[1]) ? MOVED_SECTIONS[parts[1]] : undefined;
  if (moved) return { section: moved, pair: false };
  const section = isSection(parts[1]) ? parts[1] : null;
  return { section, pair: section === 'devices' && parts[2] === 'pair' };
}

export function movedSettingsHash(hash: string): string | null {
  const parts = hash.split('/');
  if (parts[0] !== 'settings' || parts[1] === undefined || !Object.hasOwn(MOVED_SECTIONS, parts[1])) return null;
  return settingsHash({ section: MOVED_SECTIONS[parts[1]] });
}

export function settingsHash(address: Partial<SettingsAddress>): string {
  if (!address.section) return 'settings';
  return address.section === 'devices' && address.pair ? 'settings/devices/pair' : `settings/${address.section}`;
}
