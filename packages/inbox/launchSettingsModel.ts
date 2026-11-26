/** Settings → Agents: starting agents from New message (config.json `inboxLaunch`). Off, only `enabled` and a false `full_permissions`. */
export interface InboxLaunchSettings {
  /** "Start agents from New message": on unless config.json `inboxLaunch.enabled` is false (off by default on Windows). */
  enabled: boolean;
  /** Windows: launch has no support there, so Settings → Agents shows no switch (config.json only). */
  unsupported?: boolean;
  /** "Start new sessions with full permissions": Claude Code starts in bypass mode (otherwise auto mode). */
  full_permissions: boolean;
  /** Never set by the person, and on because their Claude settings (`claude`) or their shell (`shell`) run Claude in bypass mode. */
  follows?: 'claude' | 'shell' | null;
  /** A launch starts in the person's own Claude default mode (not auto). */
  own_mode?: boolean;
  /** Full permissions wanted, but Claude Code's bypass notice is not accepted on this computer: a launch starts without them. */
  needs_consent?: boolean;
  /** Full permissions wanted, but Claude Code's own settings turn bypass mode off: a launch starts without them. */
  bypass_off?: boolean;
  /** Where new scratch folders go (absolute), and as shown (`~/…`). Absent from an older Inbox. */
  scratch_dir?: string;
  scratch_dir_shown?: string;
  /** Only the path: the file may hold a secret. */
  settings_file?: string | null;
  settings_file_shown?: string;
}
