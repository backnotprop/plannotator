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
    `case "$2" in /* | [A-Za-z]:['\\/']* | '\\\\'*) cd -P -- "$2" ;; *) cd -P -- "$1" && cd -P -- "./$2" ;; esac 2>/dev/null || exit 3`,
    'pwd -W',
  ].join('\n'),
}

export function gitBashShell(bash: string): ModShell {
  return { argv: (id, posix, tag, args) => [bash, '-c', MSYS_SCRIPTS[id] ?? posix, tag, ...args], windows: true, name: 'sh' }
}

export async function findGitBash(host: ShellHost): Promise<string | null> {
  const candidates = [await host.env('CLAUDE_CODE_GIT_BASH_PATH')]
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

function gitInstallRoot(dir: string): string | null {
  const match = /^(.+?)[\\/](?:cmd|bin|mingw64[\\/]bin)$/i.exec(dir)
  return match && isAbsolutePath(dir) ? (match[1] as string) : null
}
