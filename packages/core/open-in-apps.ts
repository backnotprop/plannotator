export type OpenInKind = 'file-manager' | 'editor' | 'terminal';

export interface OpenInApp {
  id: string;
  label: string;
  kind: OpenInKind;
  icon: string;
  mac?: { appName: string };
  /** Windows PATH binary. */
  win?: { bin: string };
  linux?: { bin: string };
  /** `--goto <path>:<line>` or `<path>:<line>` on its Windows and Linux binary. */
  line?: { mac?: string; cli?: 'goto' | 'suffix' };
}

/** The catalog, in menu order. */
export const OPEN_IN_APPS: OpenInApp[] = [
  {
    id: 'reveal',
    label: 'Finder',
    kind: 'file-manager',
    icon: 'finder',
  },

  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'editor',
    icon: 'vscode',
    mac: { appName: 'Visual Studio Code' },
    win: { bin: 'code' },
    linux: { bin: 'code' },
    line: { mac: 'vscode', cli: 'goto' },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'editor',
    icon: 'cursor',
    mac: { appName: 'Cursor' },
    win: { bin: 'cursor' },
    linux: { bin: 'cursor' },
    line: { mac: 'cursor', cli: 'goto' },
  },
  {
    id: 'zed',
    label: 'Zed',
    kind: 'editor',
    icon: 'zed',
    mac: { appName: 'Zed' },
    win: { bin: 'zed' },
    linux: { bin: 'zed' },
    line: { cli: 'suffix' },
  },
  {
    id: 'zed-preview',
    label: 'Zed Preview',
    kind: 'editor',
    icon: 'zed',
    // Zed's Linux install script and Windows installer both expose the preview CLI as plain `zed`,
    // so the 'zed' entry above already covers preview there.
    mac: { appName: 'Zed Preview' },
  },
  {
    id: 'sublime-text',
    label: 'Sublime Text',
    kind: 'editor',
    icon: 'sublime-text',
    mac: { appName: 'Sublime Text' },
    win: { bin: 'subl' },
    linux: { bin: 'subl' },
    line: { cli: 'suffix' },
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
    mac: { appName: 'iTerm' },
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

/** Per-platform label for the 'reveal' (file-manager) entry. */
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
 * Per-platform icon for the 'reveal' (file-manager) entry: finder on mac/linux, file-explorer on
 * win.
 */
export function resolveRevealIcon(platform: OpenInPlatform): string {
  return platform === 'win' ? 'file-explorer' : 'finder';
}

/** Look up a catalog entry by id. */
export function getOpenInApp(id: string): OpenInApp | undefined {
  return OPEN_IN_APPS.find((app) => app.id === id);
}

export type OpenInAppIdCheck =
  | { ok: true; app: OpenInApp }
  | { ok: false; error: string };

/**
 * Validate the `appId` of a POST /api/open-in request (both runtimes). No implicit "system default"
 * launch: the OS handler can run an arbitrary file (`.command`, `.app`, scripts), so unknown ids get 400.
 */
export function checkOpenInAppId(raw: unknown): OpenInAppIdCheck {
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, error: 'Missing appId' };
  }
  const app = getOpenInApp(raw);
  if (!app) return { ok: false, error: 'Unknown app' };
  return { ok: true, app };
}
