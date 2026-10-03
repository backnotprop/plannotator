/**
 * Starting the `plannotator` CLI detached, and reading what it leaves behind.
 *
 * `$.process.run` is one shot and ends at ten minutes, so it cannot hold a
 * review open. It runs a tiny `/bin/sh` wrapper instead that starts the CLI in
 * the background with every stream on a file and returns at once. The CLI
 * itself does the rest through files in the launch directory:
 *
 *   stdin        what the CLI reads on stdin (plan JSON, the last message)
 *   ready        PLANNOTATOR_READY_FILE: one JSON line { url, isRemote, port } once listening
 *   result.json  PLANNOTATOR_HOST_RESULT_FILE: the decision record, written atomically
 *   stdout/stderr  the CLI's own output (startup errors land in stderr)
 *   pid          the CLI's pid, for the liveness check
 *   exit         the CLI's exit code, written after it exits
 *   revision.json / revision.json.ack   plan revisions pushed into an open review
 *
 * No listener in the mod: it looks at these files on a timer.
 */

import type { SessionKind } from './delivery'
import { splitShellWords } from './shell-words'

/** The wrapper. `$1` is the launch directory; the CLI argv follows. */
export const LAUNCH_SCRIPT = [
  'dir=$1; shift',
  '(',
  "  trap '' HUP",
  '  nohup "$@" < "$dir/stdin" > "$dir/stdout" 2> "$dir/stderr" &',
  '  child=$!',
  '  echo "$child" > "$dir/pid"',
  '  wait "$child"',
  '  code=$?',
  '  echo "$code" > "$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"',
  ') < /dev/null > /dev/null 2>&1 &',
].join('\n')

export const LAUNCH_FILES = {
  stdin: 'stdin',
  ready: 'ready',
  result: 'result.json',
  stdout: 'stdout',
  stderr: 'stderr',
  pid: 'pid',
  exit: 'exit',
  revision: 'revision.json',
  overflow: 'feedback.md',
} as const

export function fileIn(dir: string, name: keyof typeof LAUNCH_FILES): string {
  return `${dir}/${LAUNCH_FILES[name]}`
}

/** Polls for any of its arguments to exist, 100 ms apart, `$1` times. */
export const WAIT_SCRIPT = [
  'n=$1; shift',
  'i=0',
  'while [ "$i" -lt "$n" ]; do',
  '  for f in "$@"; do [ -e "$f" ] && exit 0; done',
  '  sleep 0.1',
  '  i=$((i+1))',
  'done',
  'exit 1',
].join('\n')

/** `$.process.run` argv that waits for any of `paths` for up to `timeoutMs`. */
export function waitArgv(paths: readonly string[], timeoutMs: number): string[] {
  return ['/bin/sh', '-c', WAIT_SCRIPT, 'plannotator-wait', String(Math.max(1, Math.ceil(timeoutMs / 100))), ...paths]
}

/** `$.process.run` argv for a detached launch of `cliArgv` in `dir`. */
export function launchArgv(dir: string, cliArgv: readonly string[]): string[] {
  return ['/bin/sh', '-c', LAUNCH_SCRIPT, 'plannotator-launch', dir, ...cliArgv]
}

/**
 * The data directory, as the CLI resolves it (`getPlannotatorDataDir`):
 * `PLANNOTATOR_DATA_DIR` (with `~` expanded); else `~/.plannotator` when it
 * exists; else `$XDG_DATA_HOME/plannotator` when that is absolute; else
 * `~/.plannotator`. A relative `PLANNOTATOR_DATA_DIR` (resolved against the
 * CLI's cwd) is refused: the mod could not name the same directory.
 */
export function dataDirOf(env: { home?: string; dataDir?: string; xdgDataHome?: string; legacyExists?: boolean }): string | null {
  const home = env.home?.replace(/\/+$/, '')
  const custom = env.dataDir?.trim()
  if (custom) {
    if (custom === '~') return home ?? null
    if (custom.startsWith('~/')) return home ? `${home}/${custom.slice(2)}` : null
    if (custom.startsWith('/')) return custom.replace(/\/+$/, '') || '/'
    return null
  }
  if (!home) return null
  const legacy = `${home}/.plannotator`
  if (env.legacyExists) return legacy
  const xdg = env.xdgDataHome?.trim()
  if (xdg && xdg.startsWith('/')) return `${xdg.replace(/\/+$/, '')}/plannotator`
  return legacy
}

/**
 * Creates a launch directory owner-only (0700, and any parent it has to
 * create) before anything is written into it: it holds the plan or message on
 * stdin and the reviewer's feedback in stdout and result.json.
 */
export function privateDirArgv(dir: string): string[] {
  return ['/bin/sh', '-c', 'umask 077 && mkdir -p "$1" && chmod 700 "$1"', 'plannotator-mkdir', dir]
}

/**
 * Removes a settled launch's files, keeping `feedback.md` (Claude reads it
 * later) and the directory when that file is there. Only names this module
 * wrote; never a glob.
 */
export function cleanupArgv(dir: string): string[] {
  const names = Object.entries(LAUNCH_FILES)
    .filter(([key]) => key !== 'overflow')
    .map(([, name]) => name)
  return [
    '/bin/sh',
    '-c',
    'dir=$1; shift; for f in "$@"; do rm -f "$dir/$f"; done; rmdir "$dir" 2>/dev/null; exit 0',
    'plannotator-cleanup',
    dir,
    ...names,
    'revision.json.ack',
    'exit.tmp',
  ]
}

/** Liveness probe through the shell's own `kill` (no /bin/kill on every system). */
export function aliveArgv(pid: string): string[] {
  return ['/bin/sh', '-c', 'kill -0 "$1" 2>/dev/null', 'plannotator-alive', pid]
}

export function launchDirOf(dataDir: string, sessionId: string, launchId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${dataDir}/claude-code-mod/${safe(sessionId)}/${safe(launchId)}`
}

export interface ReadyInfo {
  url: string
  port: number
  isRemote: boolean
}

/** The first well-formed line of the ready file. */
export function parseReadyFile(text: string): ReadyInfo | null {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (typeof value.url === 'string' && typeof value.port === 'number') {
        return { url: value.url, port: value.port, isRemote: value.isRemote === true }
      }
    } catch {
      // A partial line: not ready yet.
    }
  }
  return null
}

// --- Commands ---------------------------------------------------------------

/** The slash commands the mod runs non-blocking, by the name the user types. */
export const COMMANDS = {
  'plannotator-review': {
    kind: 'review',
    description: "Open Plannotator's code review UI; your feedback comes back as a message when you send it.",
    argumentHint: '[directory | PR URL] [--base <ref>] [--diff-type <type>]',
  },
  'plannotator-annotate': {
    kind: 'annotate',
    description: 'Annotate a file, URL or folder in Plannotator; your annotations come back as a message when you send them.',
    argumentHint: '<file | URL | folder>',
  },
  'plannotator-last': {
    kind: 'last',
    description: "Annotate Claude's last message in Plannotator; your annotations come back as a message.",
    argumentHint: '',
  },
} as const satisfies Record<string, { kind: SessionKind; description: string; argumentHint: string }>

export type CommandName = keyof typeof COMMANDS

export function isModCommand(name: string): name is CommandName {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name)
}

/** The CLI argv for a command, with the user's words passed through unchanged. */
export function cliArgvFor(kind: Exclude<SessionKind, 'plan'>, rawArgs: string): string[] {
  const words = splitShellWords(rawArgs)
  switch (kind) {
    case 'review':
      return ['plannotator', 'review', ...words]
    case 'annotate':
      return ['plannotator', 'annotate', ...words]
    case 'last':
      return ['plannotator', 'annotate-last', '--stdin']
  }
}

const PR_URL = /^https?:\/\/[^\s/]+\/.+\/(?:pull|pull-requests|merge_requests)\/(\d+)\b/i

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** How the status line, the command output and the plugin turn name a session. */
export function subjectFor(kind: SessionKind, rawArgs: string, version?: number): string {
  const words = splitShellWords(rawArgs).filter((word) => !word.startsWith('-'))
  switch (kind) {
    case 'plan':
      return `Plan v${version ?? 1}`
    case 'last':
      return "Claude's last message"
    case 'review': {
      for (const word of words) {
        const match = PR_URL.exec(word)
        if (match) return /merge_requests/i.test(word) ? `MR !${match[1]}` : `PR #${match[1]}`
      }
      const directory = words[words.length - 1]
      return directory ? `changes in ${baseName(directory)}` : 'local changes'
    }
    case 'annotate': {
      const target = words.find((word) => /^https?:\/\//i.test(word) || /[./]/.test(word)) ?? words[0]
      if (!target) return 'document'
      if (/^https?:\/\//i.test(target)) {
        try {
          return new URL(target).host
        } catch {
          return target
        }
      }
      return baseName(target)
    }
  }
}

/** The text of the last assistant message that has any. */
export function lastAssistantText(messages: readonly { role: string; text: string }[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === 'assistant' && message.text.trim()) return message.text
  }
  return null
}

/** The command's own output once the server is up. */
export function openedText(kind: SessionKind, subject: string, url: string, extra?: string): string {
  const detail = extra ? ` · ${extra}` : ''
  const second = kind === 'review'
    ? 'Take your time. Feedback comes back here when you send it.'
    : 'Your annotations come back here as a message when you send them.'
  return `Opened ${subject} in Plannotator${detail} · ${url}\n${second}`
}

/** Startup failure: what the CLI printed, trimmed for the transcript. */
export function failedText(subject: string, stderr: string, stdout: string, exitCode: number | null): string {
  const output = (stderr.trim() || stdout.trim()).slice(0, 4000)
  const code = exitCode === null ? '' : ` (exit ${exitCode})`
  return output
    ? `Plannotator could not open ${subject}${code}:\n${output}`
    : `Plannotator could not open ${subject}${code}.`
}
