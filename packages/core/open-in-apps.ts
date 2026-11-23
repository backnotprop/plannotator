/**
 * Open-in-App Catalog — single source of truth.
 *
 * Shared between the Bun/Pi servers (which launch the app) and the UI (which
 * renders the picker). Runtime-agnostic: no Bun or Node-specific APIs, pure
 * data + types only.
 *
 * Mirrors OpenCode's "Open in" app list. Each entry declares how to launch the
 * app per platform:
 *   - mac.appName  -> `open -a "<appName>" <target>` (or `open -na … --args`, openInMacArgv)
 *   - win.bin      -> `<bin> <target>` (resolved against PATH; `exeOnly`: a real .exe only)
 *   - linux.bin    -> `<bin> <target>`
 * Where each is installed is decided by `locateOpenInApp` (packages/shared/open-in-locate.ts).
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
  /**
   * macOS application bundle/display name passed to `open -a`. `also`: other
   * bundle names the same app installs under, tried in order after `appName`.
   */
  mac?: { appName: string; also?: readonly string[] };
  /**
   * Windows PATH binary. `also`: other names, tried in order after `bin`.
   * `exeOnly`: only a real `.exe` is ever launched, by its absolute path, never
   * a `.cmd`/`.bat` (those run through cmd.exe, which parses the file path), and
   * it is also looked for in the JetBrains install folders (`openInWinInstallRoots`).
   */
  win?: { bin: string; also?: readonly string[]; exeOnly?: boolean };
  /** Linux PATH binary. `also`: other names (snap commands), tried in order after `bin`. */
  linux?: { bin: string; also?: readonly string[] };
  /**
   * How it opens a file at a line. `mac`: the app's URL scheme, `<scheme>://file/<path>:<line>`
   * through `open -a`. `macArgs: 'line-flag'`: `open -na <app> --args --line <n> <path>`, which
   * hands the arguments to the app's own launcher (it forwards them to a running instance).
   * `macDefaultLine`: also use that launcher at this line if no line was selected.
   * `cli`: `--goto <path>:<line>`, `<path>:<line>`, or `--line n <path>` on its Windows and
   * Linux binary. Absent: the file opens at its top.
   */
  line?: {
    mac?: string;
    macArgs?: 'line-flag';
    macDefaultLine?: number;
    cli?: 'goto' | 'suffix' | 'line-flag';
  };
}

/**
 * One JetBrains IDE in the catalog. Names are JetBrains' documented ones:
 *  - macOS: the app bundle (`/Applications` or the Toolbox App's `~/Applications`),
 *    then the older names the same IDE installed under (`also`).
 *  - Windows: the IDE's own `.exe` launcher (`idea64.exe --line 42 <file>` in the docs),
 *    on PATH (the installer's "add launchers dir to PATH") or in a JetBrains install
 *    folder. Never the Toolbox `idea.cmd` script or the installer's `idea.bat`.
 *  - Linux: the launcher script on PATH (Toolbox, "Create Command-line Launcher"),
 *    then the snap commands.
 * `--line <n> <path>` is the documented way to open a file at a line, on every platform.
 */
function jetbrainsIde(
  id: string,
  label: string,
  icon: string,
  names: { mac: readonly string[]; win: readonly string[]; linux: readonly string[] },
): OpenInApp {
  const [appName, ...macAlso] = names.mac;
  const [winBin, ...winAlso] = names.win;
  const [linuxBin, ...linuxAlso] = names.linux;
  return {
    id,
    label,
    kind: 'editor',
    icon,
    mac: { appName, ...(macAlso.length ? { also: macAlso } : {}) },
    win: { bin: winBin, ...(winAlso.length ? { also: winAlso } : {}), exeOnly: true },
    linux: { bin: linuxBin, ...(linuxAlso.length ? { also: linuxAlso } : {}) },
    line: { macArgs: 'line-flag', cli: 'line-flag' },
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
    line: { macArgs: 'line-flag', macDefaultLine: 1 },
  },
  // IntelliJ IDEA and PyCharm were two editions until 2025.3 / 2025.1: the older
  // bundles ("IntelliJ IDEA Ultimate" in JetBrains' 2024.3-2025.2 docs, the
  // Community "IntelliJ IDEA CE" / "PyCharm CE") and snaps (`intellij-idea-ultimate`,
  // `-community`, `pycharm-professional`, `-community`) still open the same way.
  jetbrainsIde('intellij-idea', 'IntelliJ IDEA', 'jetbrains-ij', {
    mac: ['IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA CE'],
    win: ['idea64.exe'],
    linux: ['idea', 'intellij-idea', 'intellij-idea-ultimate', 'intellij-idea-community'],
  }),
  jetbrainsIde('webstorm', 'WebStorm', 'jetbrains-ws', { mac: ['WebStorm'], win: ['webstorm64.exe'], linux: ['webstorm'] }),
  jetbrainsIde('pycharm', 'PyCharm', 'jetbrains-pc', {
    mac: ['PyCharm', 'PyCharm CE'],
    win: ['pycharm64.exe'],
    linux: ['pycharm', 'pycharm-professional', 'pycharm-community'],
  }),
  jetbrainsIde('goland', 'GoLand', 'jetbrains-go', { mac: ['GoLand'], win: ['goland64.exe'], linux: ['goland'] }),
  jetbrainsIde('rider', 'Rider', 'jetbrains-rd', { mac: ['Rider'], win: ['rider64.exe'], linux: ['rider'] }),
  jetbrainsIde('phpstorm', 'PhpStorm', 'jetbrains-ps', { mac: ['PhpStorm'], win: ['phpstorm64.exe'], linux: ['phpstorm'] }),
  jetbrainsIde('rubymine', 'RubyMine', 'jetbrains-rm', { mac: ['RubyMine'], win: ['rubymine64.exe'], linux: ['rubymine'] }),
  jetbrainsIde('clion', 'CLion', 'jetbrains-cl', { mac: ['CLion'], win: ['clion64.exe'], linux: ['clion'] }),
  // RustRover's docs name `rustrover.exe`; `rustrover64.exe` is its siblings' pattern.
  jetbrainsIde('rustrover', 'RustRover', 'jetbrains-rr', {
    mac: ['RustRover'],
    win: ['rustrover.exe', 'rustrover64.exe'],
    linux: ['rustrover'],
  }),

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

/**
 * The argv for macOS `open` that opens `target` in the bundle `appName`.
 *  - an app with `line.macArgs` and a selected or default line: `-na <app> --args --line <n> <target>`
 *    (JetBrains' documented `open -na "<App>.app" --args …`; `-n` makes `open` start
 *    the app's launcher even when the app runs, and the launcher hands the file
 *    and line to the running instance);
 *  - otherwise `-a <app> <opened>`, `<opened>` from openInMacOpened.
 * No shell is involved; `target` is the server's validated absolute path.
 */
export function openInMacArgv(app: OpenInApp, appName: string, target: string, line?: number): string[] {
  const launcherLine = line ?? app.line?.macDefaultLine;
  if (launcherLine && app.kind === 'editor' && app.line?.macArgs === 'line-flag') {
    return ['-na', appName, '--args', '--line', String(launcherLine), target];
  }
  return ['-a', appName, openInMacOpened(app, target, line)];
}

/** The names a catalog app is looked for under on `platform`, in order. */
export function openInCandidateNames(app: OpenInApp, platform: OpenInPlatform): string[] {
  if (platform === 'mac') return app.mac ? [app.mac.appName, ...(app.mac.also ?? [])] : [];
  if (platform === 'win') return app.win ? [app.win.bin, ...(app.win.also ?? [])] : [];
  return app.linux ? [app.linux.bin, ...(app.linux.also ?? [])] : [];
}

/**
 * Windows folders an `exeOnly` app's launcher is looked for in, one level down:
 * `<root>\<any folder>\bin\<exe>`. They are the folders JetBrains' Toolbox App
 * documents as where IDEs are installed and detected (`%LOCALAPPDATA%\Programs`,
 * and `%PROGRAMFILES%`, where the standalone installer puts `JetBrains\<IDE>`).
 * Each entry is an environment variable and the path below it.
 */
export const OPEN_IN_WIN_INSTALL_ROOTS: ReadonlyArray<{ env: string; sub: string }> = [
  { env: 'LOCALAPPDATA', sub: 'Programs' },
  { env: 'ProgramFiles', sub: 'JetBrains' },
];

/** A Windows path that names a `.exe` (what an `exeOnly` app may launch). */
export function isWindowsExePath(p: string): boolean {
  return /\.exe$/i.test(p);
}

/** A 1-based line from a POST body. Anything else is ignored (open at the top). */
export function parseOpenInLine(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}
