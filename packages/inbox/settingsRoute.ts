/**
 * Settings' addresses (design of record `.product/approved/inbox-settings-tabs/`):
 * one section per page, `#settings/<section>`, and `#settings/devices/pair`
 * opens Pair a phone. `#settings` alone is General on a desktop and the
 * list of sections on a phone. An unknown section reads as `#settings`, so
 * an old or mistyped link still lands in Settings.
 */

export const SETTINGS_SECTIONS = ['general', 'agents', 'devices', 'archived', 'storage', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_SECTION_LABEL: Record<SettingsSection, string> = {
  general: 'General',
  agents: 'Agents',
  devices: 'Devices',
  archived: 'Archived',
  storage: 'Storage',
  about: 'About',
};

export interface SettingsAddress {
  /** Null: `#settings` alone. */
  section: SettingsSection | null;
  /** `#settings/devices/pair`: Pair a phone is open. */
  pair: boolean;
}

function isSection(value: string | undefined): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value ?? '');
}

/** Read a hash (without its `#`) as a Settings address, or null when it is not one. */
export function parseSettingsHash(hash: string): SettingsAddress | null {
  const parts = hash.split('/');
  if (parts[0] !== 'settings') return null;
  const section = isSection(parts[1]) ? parts[1] : null;
  return { section, pair: section === 'devices' && parts[2] === 'pair' };
}

/** The hash (without `#`) of a Settings address. */
export function settingsHash(address: Partial<SettingsAddress>): string {
  if (!address.section) return 'settings';
  return address.section === 'devices' && address.pair ? 'settings/devices/pair' : `settings/${address.section}`;
}
