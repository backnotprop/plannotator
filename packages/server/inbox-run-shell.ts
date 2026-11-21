/**
 * Plannotator Inbox: the program a `:::run` command runs under, and the clipboard "Open in terminal" fills.
 *
 * Agents write POSIX shell (the guide says so). On macOS and Linux that is the person's login shell when it is a
 * POSIX one (sh, bash, zsh, dash, ksh), else bash, else /bin/sh: a fish or nushell user still gets the snippet's
 * meaning. On Windows it is Git Bash when Git for Windows is installed (found the way Claude Code finds it), else
 * PowerShell 7, else Windows PowerShell; in PowerShell each secret the command names is set as `$NAME` before it,
 * so the same text reads it. The choice comes from the login environment only: a saved secret never picks the
 * program (its names cannot be PATH, SHELL and the like either; core/inbox-run-blocks.ts).
 *
 * The command's bytes reach the shell as they are. A POSIX argv is exact. Windows hands a program one command line
 * that Git Bash (and its bin\bash.exe wrapper) and PowerShell parse again, so there the agent's text never goes on
 * it: Git Bash gets a fixed `eval "$PLANNOTATOR_RUN_COMMAND"` and the command in that variable (an environment
 * string is not parsed again; no secret can have a PLANNOTATOR_ name), and PowerShell gets `-EncodedCommand`, the
 * script as base64 of its UTF-16LE bytes.
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

/** The variable Git Bash reads the command from (a fixed `eval` on the command line, the text in the env). */
export const INBOX_RUN_COMMAND_VAR = "PLANNOTATOR_RUN_COMMAND";

/**
 * PowerShell's own variables (automatic and preference ones, any case): a secret named like one is not set as
 * `$NAME` (it would fail, or change how PowerShell behaves); the command reads it as `$env:NAME` there.
 */
const POWERSHELL_OWN = new Set([
  "ARGS", "CONSOLEFILENAME", "ENABLEDEXPERIMENTALFEATURES", "ERROR", "EVENT", "EVENTARGS", "EVENTSUBSCRIBER",
  "EXECUTIONCONTEXT", "FALSE", "FOREACH", "HOME", "HOST", "INPUT", "ISCORECLR", "ISLINUX", "ISMACOS", "ISWINDOWS",
  "LASTEXITCODE", "MATCHES", "MYINVOCATION", "NESTEDPROMPTLEVEL", "NULL", "PID", "PROFILE", "PSBOUNDPARAMETERS",
  "PSCMDLET", "PSCOMMANDPATH", "PSCULTURE", "PSDEBUGCONTEXT", "PSEDITION", "PSHOME", "PSITEM", "PSSCRIPTROOT",
  "PSSENDERINFO", "PSUICULTURE", "PSVERSIONTABLE", "PWD", "SENDER", "SHELLID", "STACKTRACE", "SWITCH", "THIS", "TRUE",
  "CONFIRMPREFERENCE", "DEBUGPREFERENCE", "ERRORACTIONPREFERENCE", "ERRORVIEW", "FORMATENUMERATIONLIMIT",
  "INFORMATIONPREFERENCE", "LOGCOMMANDHEALTHEVENT", "LOGCOMMANDLIFECYCLEEVENT", "LOGENGINEHEALTHEVENT",
  "LOGENGINELIFECYCLEEVENT", "LOGPROVIDERHEALTHEVENT", "LOGPROVIDERLIFECYCLEEVENT", "MAXIMUMALIASCOUNT",
  "MAXIMUMDRIVECOUNT", "MAXIMUMERRORCOUNT", "MAXIMUMFUNCTIONCOUNT", "MAXIMUMHISTORYCOUNT", "MAXIMUMVARIABLECOUNT",
  "OFS", "OUTPUTENCODING", "PROGRESSPREFERENCE", "PSDEFAULTPARAMETERVALUES", "PSEMAILSERVER",
  "PSMODULEAUTOLOADINGPREFERENCE", "PSNATIVECOMMANDARGUMENTPASSING", "PSNATIVECOMMANDUSEERRORACTIONPREFERENCE",
  "PSSESSIONAPPLICATIONNAME", "PSSESSIONCONFIGURATIONNAME", "PSSESSIONOPTION", "PSSTYLE", "TRANSCRIPT",
  "VERBOSEPREFERENCE", "WARNINGPREFERENCE", "WHATIFPREFERENCE",
]);
export const isPowerShellOwnVariable = (name: string): boolean => POWERSHELL_OWN.has(name.toUpperCase());

/** A PowerShell script as `-EncodedCommand` takes it: base64 of its UTF-16LE bytes. */
export const powerShellEncoded = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

/**
 * The program, its arguments and what its environment adds, for a command. POSIX shells get `-c` and the command
 * as it is. Git Bash gets a fixed `eval` and the command in `PLANNOTATOR_RUN_COMMAND`. PowerShell gets the script
 * encoded: `$NAME = $env:NAME;` for each secret the command names (not PowerShell's own names), then the command,
 * with the execution policy lifted for this one process (npm.ps1 and the like would be refused otherwise).
 */
export function inboxRunArgv(command: string, shell: InboxRunShell, secretNames: readonly string[] = []): { argv: string[]; env: Record<string, string> } {
  if (shell.kind === "posix") return { argv: [shell.path, "-c", command], env: {} };
  if (shell.kind === "git-bash") return { argv: [shell.path, "-c", `eval "$${INBOX_RUN_COMMAND_VAR}"`], env: { [INBOX_RUN_COMMAND_VAR]: command } };
  const preamble = secretNames.filter((name) => !isPowerShellOwnVariable(name)).map((name) => `$${name} = $env:${name}; `).join("");
  return {
    argv: [shell.path, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand", powerShellEncoded(`${preamble}${command}`)],
    env: {},
  };
}

/** Syntax PowerShell does not read as a POSIX shell does (`export`, a heredoc, `if …; then`, `[[`, `VAR=x cmd`). */
const POSIX_ONLY_RE = /(^|[\s;&|])export\s+[A-Za-z_]\w*=|<<-?\s*['"]?[A-Za-z_]\w*|;\s*then\b|;\s*do\b|^\s*(fi|done|esac)\s*$|\[\[|(^|[;&|]\s*)[A-Za-z_]\w*=\S*\s+[A-Za-z.\/]/m;

/**
 * Why a command may not work in the shell it would run in, for the card; null when nothing says so. Only
 * PowerShell can disagree with a POSIX snippet: Git Bash and the POSIX shells read it as written.
 */
export function inboxRunShellNote(command: string, shell: InboxRunShell, computer: string, secretNames: readonly string[] = []): string | null {
  if (shell.kind !== "powershell") return null;
  const notes: string[] = [];
  if (POSIX_ONLY_RE.test(command) || (shell.edition === 5 && /&&|\|\|/.test(command))) {
    notes.push(`This is written for a Unix shell, and ${computer} has no Git Bash, so it would run in PowerShell, where it may not work. Install Git for Windows, or open it in your terminal.`);
  }
  const own = secretNames.filter(isPowerShellOwnVariable);
  if (own.length > 0) {
    notes.push(`In PowerShell, ${own.map((n) => `$${n}`).join(" and ")} ${own.length === 1 ? "is" : "are"} PowerShell's own: the command gets ${own.length === 1 ? "this secret" : "these secrets"} only as ${own.map((n) => `$env:${n}`).join(" and ")}.`);
  }
  return notes.length > 0 ? notes.join(" ") : null;
}

/** Windows' limit for one command line (CreateProcess), and for one environment value, less some room. */
export const INBOX_RUN_WINDOWS_MAX = 32_000;

/**
 * Whether a program is too long for Windows to start: its command line (PowerShell's -EncodedCommand makes about
 * 2.7 characters of each one, so about 12,000 characters of command) or Git Bash's command variable. POSIX: never.
 */
export function inboxRunTooLong(program: { argv: readonly string[]; env: Readonly<Record<string, string>> }, shell: InboxRunShell): boolean {
  if (shell.kind === "posix") return false;
  return program.argv.join(" ").length > INBOX_RUN_WINDOWS_MAX || (program.env[INBOX_RUN_COMMAND_VAR]?.length ?? 0) > INBOX_RUN_WINDOWS_MAX;
}

/** Windows: the clipboard from stdin, read as UTF-8. */
export const WINDOWS_CLIPBOARD_SCRIPT = "[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())";

/**
 * Put text on this computer's clipboard (Open in terminal: the command, to paste into the terminal that just opened
 * here, whichever device pressed). The text goes on stdin, never argv. False when there is no clipboard tool.
 */
export function systemClipboard(platform: NodeJS.Platform, which: (cmd: string) => string | null): (text: string) => Promise<boolean> {
  const argv = (): string[] | null => {
    if (platform === "darwin") return ["/usr/bin/pbcopy"];
    // Redirected stdin is read in the console's code page: UTF-8 is set first, so any text arrives as it is.
    if (platform === "win32") return ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", powerShellEncoded(WINDOWS_CLIPBOARD_SCRIPT)];
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
