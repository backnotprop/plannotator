/**
 * Open-in-App Catalog — single source of truth.
 *
 * Shared between the Bun/Pi servers (which launch the app) and the UI (which
 * renders the picker). Runtime-agnostic: no Bun or Node-specific APIs, pure
 * data + types only.
 *
 * Mirrors OpenCode's "Open in" app list. Each entry declares how to launch the
 * app per platform:
 *   - mac.appName  -> `open -a "<appName>" <target>`
 *   - win.bin      -> `<bin> <target>` (resolved against PATH)
 *   - linux.bin    -> `<bin> <target>`
 *
 * `kind` drives launch semantics:
 *   - file-manager -> reveal the file (mac: `open -R`, win: `explorer /select,`,
 *     linux: open the parent dir)
 *   - editor       -> open the file itself
 *   - terminal     -> open the file's parent directory
 *
 * One special id has no platform launch fields:
 *   - 'reveal' (kind file-manager) — uses the OS file manager
 */

export type OpenInKind = 'file-manager' | 'editor' | 'terminal';

export interface OpenInApp {
  /** Stable identifier persisted in the cookie + sent to the server. */
  id: string;
  /** Human-readable label. For 'reveal' this is resolved per-platform. */
  label: string;
  kind: OpenInKind;
  /** Icon id understood by AppIcon. For 'reveal' this is resolved per-platform. */
  icon: string;
  /** macOS application bundle/display name passed to `open -a`. */
  mac?: { appName: string };
  /** Windows PATH binary. */
  win?: { bin: string };
  /** Linux PATH binary. */
  linux?: { bin: string };
}

/**
 * The catalog, in menu order. The UI groups by `kind`
 * (file-manager + default first, then editors, then terminals).
 */
export const OPEN_IN_APPS: OpenInApp[] = [
  // ── File manager (always available) ────────────────────────────────────
  {
    id: 'reveal',
    label: 'Finder', // resolved per-platform, see resolveRevealLabel
    kind: 'file-manager',
    icon: 'finder', // resolved per-platform, see resolveRevealIcon
  },

  // ── Editors ────────────────────────────────────────────────────────────
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'editor',
    icon: 'vscode',
    mac: { appName: 'Visual Studio Code' },
    win: { bin: 'code' },
    linux: { bin: 'code' },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'editor',
    icon: 'cursor',
    mac: { appName: 'Cursor' },
    win: { bin: 'cursor' },
    linux: { bin: 'cursor' },
  },
  {
    id: 'zed',
    label: 'Zed',
    kind: 'editor',
    icon: 'zed',
    mac: { appName: 'Zed' },
    win: { bin: 'zed' },
    linux: { bin: 'zed' },
  },
  {
    id: 'sublime-text',
    label: 'Sublime Text',
    kind: 'editor',
    icon: 'sublime-text',
    mac: { appName: 'Sublime Text' },
    win: { bin: 'subl' },
    linux: { bin: 'subl' },
  },
  {
    id: 'textmate',
    label: 'TextMate',
    kind: 'editor',
    icon: 'textmate',
    mac: { appName: 'TextMate' },
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    kind: 'editor',
    icon: 'antigravity',
    mac: { appName: 'Antigravity' },
  },
  {
    id: 'xcode',
    label: 'Xcode',
    kind: 'editor',
    icon: 'xcode',
    mac: { appName: 'Xcode' },
  },
  {
    id: 'android-studio',
    label: 'Android Studio',
    kind: 'editor',
    icon: 'android-studio',
    mac: { appName: 'Android Studio' },
  },

  // ── Terminals ──────────────────────────────────────────────────────────
  {
    id: 'terminal',
    label: 'Terminal',
    kind: 'terminal',
    icon: 'terminal',
    mac: { appName: 'Terminal' },
  },
  {
    id: 'iterm2',
    label: 'iTerm2',
    kind: 'terminal',
    icon: 'iterm2',
    mac: { appName: 'iTerm' }, // bundle name is "iTerm", not "iTerm2"
  },
  {
    id: 'ghostty',
    label: 'Ghostty',
    kind: 'terminal',
    icon: 'ghostty',
    mac: { appName: 'Ghostty' },
  },
  {
    id: 'warp',
    label: 'Warp',
    kind: 'terminal',
    icon: 'warp',
    mac: { appName: 'Warp' },
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    kind: 'terminal',
    icon: 'powershell',
    win: { bin: 'powershell' },
  },
];

export type OpenInPlatform = 'mac' | 'win' | 'linux';

/**
 * Per-platform label for the 'reveal' (file-manager) entry.
 */
export function resolveRevealLabel(platform: OpenInPlatform): string {
  switch (platform) {
    case 'win':
      return 'Explorer';
    case 'linux':
      return 'Files';
    case 'mac':
    default:
      return 'Finder';
  }
}

/**
 * Per-platform icon for the 'reveal' (file-manager) entry:
 * finder on mac/linux, file-explorer on win.
 */
export function resolveRevealIcon(platform: OpenInPlatform): string {
  return platform === 'win' ? 'file-explorer' : 'finder';
}

/**
 * Look up a catalog entry by id.
 */
export function getOpenInApp(id: string): OpenInApp | undefined {
  return OPEN_IN_APPS.find((app) => app.id === id);
}
