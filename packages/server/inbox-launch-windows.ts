const DRIVE_PATH = /^([A-Za-z]):(?:[\\/]|$)/;

export function claudeRulePathOf(folder: string): string {
  const drive = DRIVE_PATH.exec(folder);
  const slashed = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!drive) return slashed;
  return `/${drive[1]!.toLowerCase()}${slashed.slice(2)}`;
}

export function claudeWindowsTrustKey(key: string): string {
  return key.replace(/\\/g, "/");
}

export function claudeWindowsTrustKeys(key: string): string[] {
  const slashed = claudeWindowsTrustKey(key);
  const drive = DRIVE_PATH.exec(slashed);
  const forms = drive
    ? [`${drive[1]!.toUpperCase()}${slashed.slice(1)}`, `${drive[1]!.toLowerCase()}${slashed.slice(1)}`]
    : [slashed];
  forms.push(key.replace(/\//g, "\\"));
  return [...new Set(forms)];
}

export function powerShellQuote(value: string): string {
  return /^[A-Za-z0-9_.:\\/-]+$/.test(value) && !value.startsWith("-") ? value : singleQuoted(value);
}

export function powerShellInFolder(folder: string, command: string): string {
  return `Set-Location -LiteralPath ${singleQuoted(folder)}; if ($?) { ${command} }`;
}

export function powerShellCommandLine(argv: readonly string[]): string {
  const [program = "", ...args] = argv;
  return [`&`, singleQuoted(program), ...args.map(powerShellQuote)].join(" ") + "; exit $LASTEXITCODE";
}

function singleQuoted(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;
}

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

function splitWindows(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

export const FILE_ATTRIBUTE_HIDDEN = 0x2;
export const FILE_ATTRIBUTE_SYSTEM = 0x4;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;

export function hiddenByAttributes(attributes: number | null | undefined): boolean {
  if (attributes === undefined) return false;
  if (attributes === null || attributes === INVALID_FILE_ATTRIBUTES) return true;
  return (attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) !== 0;
}

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
  for (let n = 2; n <= parts.length; n++) {
    const path = `${parts.slice(0, n).join("\\")}`;
    if (parts[n - 1]!.startsWith(".") || hiddenByAttributes(attributesOf(path))) return "hidden";
  }
  return null;
}

let getAttributes: ((path: string) => number) | null | undefined;

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

export function windowsFolderHidden(path: string): boolean {
  return process.platform === "win32" && hiddenByAttributes(windowsAttributesOf(path));
}
