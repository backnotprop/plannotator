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
  /**
   * How it opens a file at a line. `mac`: the app's URL scheme, `<scheme>://file/<path>:<line>`
   * through `open -a`. `cli`: `--goto <path>:<line>`, `<path>:<line>`, or `--line n <path>` on
   * its Windows and Linux binary. Absent: the file opens at its top. A `cli` with no `mac`
   * (JetBrains) still opens at the top on macOS: `open -a` has no line, and those IDEs have no
   * matching `scheme://file/path:line` URL.
   */
  line?: { mac?: string; cli?: 'goto' | 'suffix' | 'line-flag' };
}

/**
 * One JetBrains IDE in the catalog. Toolbox and the "Create Command-line Launcher"
 * scripts are `idea`, `webstorm`, … (`idea.cmd` on Windows is what `which idea` finds).
 * `--line <n> <path>` is the documented CLI; Community Edition bundles (`IntelliJ IDEA CE`,
 * `PyCharm CE`) are skipped because they share the same linux/win bin as Ultimate.
 */
function jetbrainsIde(id: string, label: string, bin: string, appName: string): OpenInApp {
  return {
    id,
    label,
    kind: 'editor',
    icon: 'jetbrains',
    mac: { appName },
    win: { bin },
    linux: { bin },
    line: { cli: 'line-flag' },
  };
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
    // Preview installs as a separate app bundle only on macOS. Zed's Linux
    // install script and Windows installer both expose the preview CLI as
    // plain `zed`, so the 'zed' entry above already covers preview there.
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
  jetbrainsIde('intellij-idea', 'IntelliJ IDEA', 'idea', 'IntelliJ IDEA'),
  jetbrainsIde('webstorm', 'WebStorm', 'webstorm', 'WebStorm'),
  jetbrainsIde('pycharm', 'PyCharm', 'pycharm', 'PyCharm'),
  jetbrainsIde('goland', 'GoLand', 'goland', 'GoLand'),
  jetbrainsIde('rider', 'Rider', 'rider', 'Rider'),
  jetbrainsIde('phpstorm', 'PhpStorm', 'phpstorm', 'PhpStorm'),
  jetbrainsIde('rubymine', 'RubyMine', 'rubymine', 'RubyMine'),
  jetbrainsIde('clion', 'CLion', 'clion', 'CLion'),
  jetbrainsIde('rustrover', 'RustRover', 'rustrover', 'RustRover'),

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

export type OpenInAppIdCheck =
  | { ok: true; app: OpenInApp }
  | { ok: false; error: string };

/**
 * Validate the `appId` of a POST /api/open-in request (both runtimes).
 *
 * The id must name a catalog entry. There is no implicit "system default"
 * launch: handing an arbitrary file to the OS default handler can run it
 * (`.command`, `.app`, `.terminal` on macOS, scripts and executables
 * elsewhere), and the UI always sends a catalog id (the reveal entry at
 * least), so a missing or unknown id is refused with 400 instead.
 */
export function checkOpenInAppId(raw: unknown): OpenInAppIdCheck {
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, error: 'Missing appId' };
  }
  const app = getOpenInApp(raw);
  if (!app) return { ok: false, error: 'Unknown app' };
  return { ok: true, app };
}

/**
 * The catalog binary's argv for a file, at `line` when the app's launcher takes one.
 * Shared so the Bun and Pi launchers cannot drift.
 */
export function openInFileArgv(app: OpenInApp, target: string, line?: number): string[] {
  if (!line || app.kind !== 'editor') return [target];
  if (app.line?.cli === 'goto') return ['--goto', `${target}:${line}`];
  if (app.line?.cli === 'suffix') return [`${target}:${line}`];
  if (app.line?.cli === 'line-flag') return ['--line', String(line), target];
  return [target];
}

/**
 * What macOS `open -a` is handed: a URL with the line when the app has a scheme,
 * otherwise the path (which opens at the top).
 */
export function openInMacOpened(app: OpenInApp, target: string, line?: number): string {
  const scheme = line && app.kind === 'editor' ? app.line?.mac : undefined;
  if (!scheme) return target;
  return `${scheme}://file${target.split('/').map(encodeURIComponent).join('/')}:${line}`;
}

/** A 1-based line from a POST body. Anything else is ignored (open at the top). */
export function parseOpenInLine(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}
