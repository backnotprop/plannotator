/**
 * Plannotator Inbox: the program a `:::run` command runs under, and the clipboard "Open in terminal" fills.
 *
 * Agents write POSIX shell (the guide says so). On macOS and Linux that is the person's login shell when it is a
 * POSIX one (sh, bash, zsh, dash, ksh), else bash, else /bin/sh: a fish or nushell user still gets the snippet's
 * meaning. On Windows it is Git Bash when Git for Windows is installed (found the way Claude Code finds it), else
 * PowerShell 7, else Windows PowerShell; in PowerShell each secret the command names is set as `$NAME` before it,
 * so the same text reads it. The choice comes from the login environment only: a saved secret never picks the
 * program (its names cannot be PATH, SHELL and the like either; core/inbox-run-blocks.ts).
 */

import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { childEnv } from "@plannotator/shared/child-env";

export type InboxRunShell =
  | { kind: "posix"; path: string; name: string }
  | { kind: "git-bash"; path: string; name: "Git Bash" }
  | { kind: "powershell"; path: string; name: "PowerShell"; edition: 5 | 7 };

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash"]);

/** The shell for a POSIX computer: the login env's SHELL when it speaks POSIX, else bash, else sh. */
export function posixRunShell(env: Readonly<Record<string, string | undefined>>, exists: (path: string) => boolean = existsSync): InboxRunShell {
  const shell = env.SHELL;
  if (shell && isAbsolute(shell) && POSIX_SHELLS.has(basename(shell)) && exists(shell)) return { kind: "posix", path: shell, name: basename(shell) };
  for (const path of ["/bin/bash", "/usr/bin/bash"]) if (exists(path)) return { kind: "posix", path, name: "bash" };
  return { kind: "posix", path: "/bin/sh", name: "sh" };
}

/** `<root>\cmd`, `<root>\bin` or `<root>\mingw64\bin` of a Git for Windows install gives `<root>`. */
const gitInstallRoot = (dir: string): string | null => {
  const match = /^(.+?)[\\/](?:cmd|bin|mingw64[\\/]bin)$/i.exec(dir);
  return match && /^[A-Za-z]:[\\/]|^\\\\/.test(dir) ? match[1]! : null;
};

/**
 * Git Bash on Windows, as the Claude Code mod finds it (apps/hook/hooks/mod/git-bash.ts): CLAUDE_CODE_GIT_BASH_PATH,
 * then beside a Git for Windows `cmd\git.exe` on PATH, then the machine-wide and per-user install folders. Never a
 * bash that is WSL's, Cygwin's or MSYS2's. Null when there is none.
 */
export function findRunGitBash(env: Readonly<Record<string, string | undefined>>, exists: (path: string) => boolean = existsSync): string | null {
  const candidates: (string | undefined)[] = [env.CLAUDE_CODE_GIT_BASH_PATH];
  for (const entry of (env.PATH ?? env.Path ?? "").split(";")) {
    const root = gitInstallRoot(entry.trim().replace(/^"(.*)"$/, "$1").replace(/[\\/]+$/, ""));
    if (root && exists(`${root}\\cmd\\git.exe`)) candidates.push(`${root}\\bin\\bash.exe`);
  }
  const programFiles = env.PROGRAMFILES ?? env.ProgramFiles;
  const localAppData = env.LOCALAPPDATA;
  if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
  if (localAppData) candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
  for (const path of candidates) if (path && exists(path)) return path;
  return null;
}

/** The shell for this computer, from its login environment. `pwsh` is PowerShell 7's path when it is installed. */
export function runShellFor(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>, options: { exists?: (path: string) => boolean; pwsh?: string | null } = {}): InboxRunShell {
  const exists = options.exists ?? existsSync;
  if (platform !== "win32") return posixRunShell(env, exists);
  const bash = findRunGitBash(env, exists);
  if (bash) return { kind: "git-bash", path: bash, name: "Git Bash" };
  if (options.pwsh) return { kind: "powershell", path: options.pwsh, name: "PowerShell", edition: 7 };
  return { kind: "powershell", path: "powershell.exe", name: "PowerShell", edition: 5 };
}

/**
 * The program and arguments a command runs as. POSIX shells and Git Bash get the command as it is. PowerShell gets
 * `$NAME = $env:NAME;` for each secret the command names, then the command, with the execution policy lifted for
 * this one process (npm.ps1 and the like would be refused otherwise).
 */
export function inboxRunArgv(command: string, shell: InboxRunShell, secretNames: readonly string[] = []): string[] {
  if (shell.kind !== "powershell") return [shell.path, "-c", command];
  const preamble = secretNames.map((name) => `$${name} = $env:${name}; `).join("");
  return [shell.path, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `${preamble}${command}`];
}

/** Syntax PowerShell does not read as a POSIX shell does (`export`, a heredoc, `if …; then`, `[[`, `VAR=x cmd`). */
const POSIX_ONLY_RE = /(^|[\s;&|])export\s+[A-Za-z_]\w*=|<<-?\s*['"]?[A-Za-z_]\w*|;\s*then\b|;\s*do\b|^\s*(fi|done|esac)\s*$|\[\[|(^|[;&|]\s*)[A-Za-z_]\w*=\S*\s+[A-Za-z.\/]/m;

/**
 * Why a command may not work in the shell it would run in, for the card; null when nothing says so. Only
 * PowerShell can disagree with a POSIX snippet: Git Bash and the POSIX shells read it as written.
 */
export function inboxRunShellNote(command: string, shell: InboxRunShell, computer: string): string | null {
  if (shell.kind !== "powershell") return null;
  const posix = POSIX_ONLY_RE.test(command) || (shell.edition === 5 && /&&|\|\|/.test(command));
  if (!posix) return null;
  return `This is written for a Unix shell, and ${computer} has no Git Bash, so it would run in PowerShell, where it may not work. Install Git for Windows, or open it in your terminal.`;
}

/**
 * Put text on this computer's clipboard (Open in terminal: the command, to paste into the terminal that just opened
 * here, whichever device pressed). The text goes on stdin, never argv. False when there is no clipboard tool.
 */
export function systemClipboard(platform: NodeJS.Platform, which: (cmd: string) => string | null): (text: string) => Promise<boolean> {
  const argv = (): string[] | null => {
    if (platform === "darwin") return ["/usr/bin/pbcopy"];
    if (platform === "win32") return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"];
    const wl = which("wl-copy");
    if (wl) return [wl];
    const xclip = which("xclip");
    if (xclip) return [xclip, "-selection", "clipboard"];
    const xsel = which("xsel");
    return xsel ? [xsel, "--clipboard", "--input"] : null;
  };
  return async (text) => {
    const command = argv();
    if (!command) return false;
    try {
      const child = Bun.spawn(command, { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore", env: childEnv(), windowsHide: true });
      const timer = setTimeout(() => child.kill(), 5_000);
      const code = await child.exited;
      clearTimeout(timer);
      return code === 0;
    } catch {
      return false;
    }
  };
}
