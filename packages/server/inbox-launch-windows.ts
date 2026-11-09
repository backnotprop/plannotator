/**
 * Launch on native Windows: how its paths and commands differ, as pure
 * functions (the Windows launch plan, PR 2). Launch stays off on Windows
 * (`resolveInboxLaunch`); this only makes it able to work there.
 *
 * - Claude Code writes a permission rule's path in POSIX form, the drive as
 *   its first folder (`C:\Users\me` is `/c/Users/me`), and `//` makes a rule
 *   absolute: `Read(//c/Users/me/**)`.
 * - Claude Code keys a folder's trust in `~/.claude.json` with forward slashes
 *   (`C:/Users/me/repo`), and has written either drive-letter case over
 *   versions; some wrote the backslash form. Read all three, write the
 *   forward-slash one with the drive letter as the file system gives it.
 * - A copied command runs in PowerShell, Windows' terminal shell: single
 *   quotes, with `‘ ’ ‚ ‛` doubled too (PowerShell reads them as single
 *   quotes), and `;` with `$?` in place of `&&`, which Windows PowerShell 5.1
 *   lacks.
 * - A typed folder may use backslashes or `/`, and either drive-letter case.
 * - Hidden folders are those with the Hidden or System attribute (AppData,
 *   `Application Data` and the other junctions that refuse access), not only
 *   dot-folders.
 */

/** `C:\x`, `c:/x`: a path on a drive. */
const DRIVE_PATH = /^([A-Za-z]):(?:[\\/]|$)/;

/** A Windows path in Claude Code's rule form: `C:\Users\me` → `/c/Users/me`; another path with `/` separators. */
export function claudeRulePathOf(folder: string): string {
  const drive = DRIVE_PATH.exec(folder);
  const slashed = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!drive) return slashed;
  return `/${drive[1]!.toLowerCase()}${slashed.slice(2)}`;
}

/** A trust key as Claude Code writes it on Windows: forward slashes, the drive letter as given. */
export function claudeWindowsTrustKey(key: string): string {
  return key.replace(/\\/g, "/");
}

/** Every form Claude Code may have keyed `key`'s trust under on Windows: forward slashes in either drive case, and backslashes. */
export function claudeWindowsTrustKeys(key: string): string[] {
  const slashed = claudeWindowsTrustKey(key);
  const drive = DRIVE_PATH.exec(slashed);
  const forms = drive
    ? [`${drive[1]!.toUpperCase()}${slashed.slice(1)}`, `${drive[1]!.toLowerCase()}${slashed.slice(1)}`]
    : [slashed];
  forms.push(key.replace(/\//g, "\\"));
  return [...new Set(forms)];
}

/** One PowerShell word, single-quoted (a plain word stays bare). */
export function powerShellQuote(value: string): string {
  return /^[A-Za-z0-9_.:\\/-]+$/.test(value) && !value.startsWith("-") ? value : singleQuoted(value);
}

/** A PowerShell line that runs `command` in `folder`, and nothing when the folder can't be entered. */
export function powerShellInFolder(folder: string, command: string): string {
  return `Set-Location -LiteralPath ${singleQuoted(folder)}; if ($?) { ${command} }`;
}

/** A PowerShell line that runs the program `argv[0]` with the rest as its arguments, and exits with its exit code. */
export function powerShellCommandLine(argv: readonly string[]): string {
  const [program = "", ...args] = argv;
  // `&` runs a quoted program; `exit $LASTEXITCODE` passes its code on (PowerShell's own would be 0 or 1).
  return [`&`, singleQuoted(program), ...args.map(powerShellQuote)].join(" ") + "; exit $LASTEXITCODE";
}

/** Always single-quoted, with every PowerShell single quote doubled. */
function singleQuoted(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

/**
 * A typed Windows folder as the home-folder rules read it (`~/…` under home), or null when it is not under home.
 * Backslashes or `/`, either drive-letter case, and any case in the folders on the way (NTFS ignores case).
 * Other drives are the any-folder rule's (.product/approved/inbox-launch-any-folder): `windowsFolderRefusal`.
 */
export function windowsTypedUnderHome(typed: string, home: string): string | null {
  const text = typed.trim();
  if (text === "~" || text === "") return "~";
  if (text.startsWith("~/") || text.startsWith("~\\")) return `~/${splitWindows(text.slice(2)).join("/")}`.replace(/\/$/, "");
  if (!DRIVE_PATH.test(text)) return null;
  const parts = splitWindows(text);
  const homeParts = splitWindows(home);
  if (parts.length < homeParts.length) return null;
  for (let i = 0; i < homeParts.length; i++) if (parts[i]!.toLowerCase() !== homeParts[i]!.toLowerCase()) return null;
  const rest = parts.slice(homeParts.length);
  return rest.length === 0 ? "~" : `~/${rest.join("/")}`;
}

/** A Windows path's segments, `C:` first: `C:\a//b\` → `["C:", "a", "b"]`. */
function splitWindows(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** The Hidden and System attribute bits (`GetFileAttributesW`). */
export const FILE_ATTRIBUTE_HIDDEN = 0x2;
export const FILE_ATTRIBUTE_SYSTEM = 0x4;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;

/**
 * Whether a folder's attributes hide it: Hidden or System, or attributes that can't be read (null: access denied,
 * as on `Application Data`). Undefined (no way to read them here) hides nothing: the dot-folder rule still applies.
 */
export function hiddenByAttributes(attributes: number | null | undefined): boolean {
  if (attributes === undefined) return false;
  if (attributes === null || attributes === INVALID_FILE_ATTRIBUTES) return true;
  return (attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) !== 0;
}

/**
 * Why a real Windows folder is never one to start in, or null: the any-folder rule's system folders (the Windows
 * folder, Program Files, ProgramData, the recycle bin and the volume's own folders, anywhere under them), hidden by
 * attributes on the way down, or the Users folder and another account's profile. A drive root may be started in.
 * `attributesOf` reads one folder's attributes (`windowsAttributesOf`).
 */
export function windowsFolderRefusal(
  real: string,
  env: { systemRoot?: string; programFiles?: readonly string[]; programData?: string; home: string },
  attributesOf: (path: string) => number | null | undefined,
): "system" | "hidden" | null {
  const parts = splitWindows(real);
  if (!DRIVE_PATH.test(real) || parts.length === 0) return "system";
  const lower = parts.map((part) => part.toLowerCase());
  const under = (root: string | undefined) => {
    if (!root) return false;
    const rootParts = splitWindows(root).map((part) => part.toLowerCase());
    return rootParts.length > 0 && rootParts.length <= lower.length && rootParts.every((part, i) => part === lower[i]);
  };
  if (under(env.systemRoot) || (env.programFiles ?? []).some(under) || under(env.programData)) return "system";
  if (lower.length >= 2 && ["$recycle.bin", "system volume information", "recovery", "$windows.~bt", "$windows.~ws", "config.msi"].includes(lower[1]!)) return "system";
  const homeParts = splitWindows(env.home).map((part) => part.toLowerCase());
  const profiles = homeParts.slice(0, -1);
  // The Users folder itself, and another account's profile (C:\Users\Public included): never this person's place.
  const inProfiles = profiles.length > 0 && profiles.length <= lower.length && profiles.every((part, i) => part === lower[i]);
  if (inProfiles && (lower.length === profiles.length || lower[profiles.length] !== homeParts[homeParts.length - 1])) return "system";
  // Every folder below the drive root, by its attributes: a hidden or system one anywhere on the way hides it.
  for (let n = 2; n <= parts.length; n++) {
    const path = `${parts.slice(0, n).join("\\")}`;
    if (parts[n - 1]!.startsWith(".") || hiddenByAttributes(attributesOf(path))) return "hidden";
  }
  return null;
}

let getAttributes: ((path: string) => number) | null | undefined;

/**
 * A path's Windows attributes (`GetFileAttributesW`): null when they can't be read (no such path, access denied),
 * undefined where there is no way to read them (not Windows, or no FFI). Loaded once.
 */
export function windowsAttributesOf(path: string): number | null | undefined {
  if (process.platform !== "win32") return undefined;
  if (getAttributes === undefined) {
    try {
      const ffi = require("bun:ffi") as typeof import("bun:ffi");
      const lib = ffi.dlopen("kernel32.dll", { GetFileAttributesW: { args: [ffi.FFIType.ptr], returns: ffi.FFIType.u32 } });
      getAttributes = (target: string) => {
        const wide = Buffer.from(`${target}\0`, "utf16le");
        return lib.symbols.GetFileAttributesW(ffi.ptr(wide)) as number;
      };
    } catch {
      getAttributes = null;
    }
  }
  if (!getAttributes) return undefined;
  const attributes = getAttributes(path);
  return attributes === INVALID_FILE_ATTRIBUTES ? null : attributes;
}

/** Whether a real Windows folder is hidden by its attributes (Hidden, System, or unreadable ones). False off Windows. */
export function windowsFolderHidden(path: string): boolean {
  return process.platform === "win32" && hiddenByAttributes(windowsAttributesOf(path));
}
