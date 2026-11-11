/**
 * Git Bash, the bash that ships with Git for Windows, as the mod's shell on
 * Windows, where there is no `/bin/sh`. Git Bash is the shell's standard name,
 * and Claude Code uses the same name (`CLAUDE_CODE_GIT_BASH_PATH`) and the same
 * bash for its own shell commands. Its MSYS tools run the POSIX scripts as
 * they are, except where MSYS reports something differently:
 *
 * - `ps` has no `-o`: the stop script reads the pid's command line from
 *   `/proc` instead, which MSYS keeps for the native processes it started.
 * - `pwd` prints `/c/…`, which no native program can open: `pwd -W` prints
 *   `C:/…`.
 *
 * A pid from `$!` is an MSYS pid. `kill -0` and `kill -TERM` in another MSYS
 * shell understand it, and those are the only places the mod uses one.
 */

import { isAbsolutePath, trimTrailingSeparators } from './paths'
import type { ModShell, ShellHost, ShellScriptId } from './shell'

const MSYS_SCRIPTS: Partial<Record<ShellScriptId, string>> = {
  mkdir: 'umask 077 && mkdir -p "$1" && chmod 700 "$1" && pwd -W',
  stop: [
    'pid=$1; shift',
    'for f in "$@"; do [ -e "$f" ] && exit 3; done',
    '[ -r "/proc/$$/cmdline" ] || exit 6',
    `tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q plannotator || exit 4`,
    'kill -TERM "$pid" 2>/dev/null || exit 5',
  ].join('\n'),
  'inbox-project': [
    'CDPATH=',
    // Quoted: MSYS bash's bracket [\\/] never matches a backslash.
    `case "$2" in /* | [A-Za-z]:['\\/']* | '\\\\'*) cd -P -- "$2" ;; *) cd -P -- "$1" && cd -P -- "./$2" ;; esac 2>/dev/null || exit 3`,
    'pwd -W',
  ].join('\n'),
}

/** Runs each script in the bash at `bash`, with the MSYS variant where one is needed. */
export function gitBashShell(bash: string): ModShell {
  return { argv: (id, posix, tag, args) => [bash, '-c', MSYS_SCRIPTS[id] ?? posix, tag, ...args], windows: true, name: 'sh' }
}

/**
 * Git Bash, wherever Git for Windows is installed: `CLAUDE_CODE_GIT_BASH_PATH`
 * (Claude Code's own setting), then next to a `git.exe` on `PATH`, then the
 * default machine-wide and per-user install folders. Every folder comes from
 * the environment, never a fixed drive. Null when there is none.
 */
export async function findGitBash(host: ShellHost): Promise<string | null> {
  const candidates = [await host.env('CLAUDE_CODE_GIT_BASH_PATH')]
  // Only Git for Windows' cmd\git.exe marks its install. A bash.exe on PATH may
  // be WSL's (System32), and Cygwin's or MSYS2's git.exe sits beside a bash
  // that has no `pwd -W`.
  for (const entry of ((await host.env('PATH')) ?? '').split(';')) {
    const root = gitInstallRoot(trimTrailingSeparators(entry.trim().replace(/^"(.*)"$/, '$1')))
    if (root && (await host.exists(`${root}\\cmd\\git.exe`))) candidates.push(`${root}\\bin\\bash.exe`)
  }
  const programFiles = await host.env('PROGRAMFILES')
  const localAppData = await host.env('LOCALAPPDATA')
  if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`)
  if (localAppData) candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`)
  for (const path of candidates) if (path && (await host.exists(path))) return path
  return null
}

/** The Git install a `PATH` folder belongs to: `<root>\cmd`, `<root>\bin` or `<root>\mingw64\bin` gives `<root>`. */
function gitInstallRoot(dir: string): string | null {
  const match = /^(.+?)[\\/](?:cmd|bin|mingw64[\\/]bin)$/i.exec(dir)
  return match && isAbsolutePath(dir) ? (match[1] as string) : null
}
