/**
 * Starting the `plannotator` CLI detached, and reading what it leaves behind.
 *
 * `$.process.run` is one shot and ends at ten minutes, so it cannot hold a
 * review open. It runs a tiny `/bin/sh` wrapper instead that starts the CLI in
 * the background with every stream on a file and returns at once. The CLI
 * itself does the rest through files in the launch directory:
 *
 *   stdin        what the CLI reads on stdin (plan JSON, the last message)
 *   ready        PLANNOTATOR_READY_FILE: one JSON line { url, isRemote, port, target? } once listening
 *   result.json  PLANNOTATOR_HOST_RESULT_FILE: the decision record, written atomically
 *   stdout/stderr  the CLI's own output (startup errors land in stderr)
 *   pid          the CLI's pid, for the liveness check
 *   exit         the CLI's exit code, written after it exits
 *   revision.json / revision.json.ack   plan revisions pushed into an open review
 *   messages.json  PLANNOTATOR_HOST_MESSAGES_FILE: `last`'s recent assistant messages, for the picker
 *   watcher.json   which Claude Code process watches this launch (`{ owner, at, touchedAt }`, a heartbeat)
 *   settled/by     the claim: made (mkdir) by the one process that settles the launch, naming it
 *
 * No listener in the mod: it looks at these files on a timer.
 */

import type { SessionKind } from './delivery'
import { splitShellWords } from './shell-words'
import { looksLikeFilePath, plannotatorBundleSubject } from './tool'

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
  messages: 'messages.json',
  watcher: 'watcher.json',
  overflow: 'feedback.md',
} as const

/** The claim directory `claimArgv` makes, and the file in it naming the claimant. */
export const SETTLED_DIR = 'settled'
export const SETTLED_BY = 'settled/by'

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
 * stdin and the reviewer's feedback in stdout and result.json. Prints the
 * working directory the CLI will run in (the session's), which the mod
 * resolves relative targets against.
 */
export function privateDirArgv(dir: string): string[] {
  return ['/bin/sh', '-c', 'umask 077 && mkdir -p "$1" && chmod 700 "$1" && pwd', 'plannotator-mkdir', dir]
}

/** `/a/b/../c/./d` → `/a/c/d` (no symlinks resolved: nothing is looked up). */
function normalizeAbsolute(path: string): string {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return `/${out.join('/')}`
}

/** A word as an absolute path against `cwd`, or undefined when that cannot be known (`~`, no cwd). */
function absoluteOf(word: string, cwd: string | undefined): string | undefined {
  const path = word.replace(/^@/, '')
  if (path.startsWith('/')) return normalizeAbsolute(path)
  if (path.startsWith('~') || !cwd || !cwd.startsWith('/')) return undefined
  return normalizeAbsolute(`${cwd}/${path}`)
}

/**
 * The mod's own resolution of what a launch shows, from the words it passed
 * (flags dropped) and the session's working directory. Only a FALLBACK for a
 * CLI that predates naming its target in the ready file and result record:
 * the CLI may resolve a bare name somewhere else (it searches the project),
 * which is why its own answer always wins.
 */
export function modTargetFor(
  kind: SessionKind,
  args: string | readonly string[],
  cwd: string | undefined,
): string | string[] | undefined {
  const all = wordsOf(args)
  const words: string[] = []
  for (let index = 0; index < all.length; index += 1) {
    const word = all[index] as string
    // `--base <ref>` / `--diff-type <id>` take a value that is not a target.
    if (word === '--base' || word === '--diff-type') {
      index += 1
      continue
    }
    if (!word.startsWith('-')) words.push(word)
  }
  switch (kind) {
    case 'plan':
    case 'last':
      return undefined
    case 'review': {
      const pr = words.find((word) => PR_URL.test(word))
      if (pr) return pr
      const directory = words[words.length - 1]
      return directory ? absoluteOf(directory, cwd) : cwd && cwd.startsWith('/') ? normalizeAbsolute(cwd) : undefined
    }
    case 'annotate': {
      if (isSeveralFilePaths(words)) {
        const paths = [...new Set(words)].map((word) => absoluteOf(word, cwd))
        return paths.every((path): path is string => path !== undefined) ? paths : undefined
      }
      const target = words.find((word) => /^https?:\/\//i.test(word) || /[./]/.test(word)) ?? words[0]
      if (!target) return undefined
      if (/^https?:\/\//i.test(target)) return target
      return absoluteOf(target, cwd)
    }
  }
}

/**
 * Removes a settled launch's files, keeping `feedback.md` (Claude reads it
 * later) and the directory when that file is there. Only names this module
 * wrote; never a glob. The claim (`settled/`) goes only with the directory:
 * while `feedback.md` keeps the directory, the claim keeps saying the launch
 * was settled. Files go first, `stdin` among them, so a claim made after this
 * started finds `stdin` gone and loses (`CLAIM_SCRIPT`).
 */
export function cleanupArgv(dir: string): string[] {
  const names = Object.entries(LAUNCH_FILES)
    .filter(([key]) => key !== 'overflow')
    .map(([, name]) => name)
  return [
    '/bin/sh',
    '-c',
    [
      'dir=$1; shift',
      'for f in "$@"; do rm -f "$dir/$f"; done',
      `if [ ! -e "$dir/${LAUNCH_FILES.overflow}" ]; then rm -f "$dir/${SETTLED_BY}" "$dir/${SETTLED_DIR}/delivered" "$dir/${SETTLED_DIR}/reported"; rmdir "$dir/${SETTLED_DIR}" 2>/dev/null; rmdir "$dir" 2>/dev/null; fi`,
      'exit 0',
    ].join('\n'),
    'plannotator-cleanup',
    dir,
    ...names,
    'revision.json.ack',
    'exit.tmp',
  ]
}

/** Exit codes of `CLAIM_SCRIPT`. */
export const CLAIM_EXIT = { won: 0, lost: 3, failed: 4 } as const

/**
 * Claims one launch's settlement across Claude Code processes: two processes
 * on one session id (`claude --continue` while the first still runs) both
 * watch the launch, and only the one that makes `$1/settled` (mkdir is atomic
 * and fails when it exists: exactly one winner) settles it, whichever file
 * says it is settled (the result record, the exit code, or a dead pid). The
 * winner writes its id (`$2`) to `settled/by`, so the same instance that
 * claimed but lost the answer (a timed-out process call) wins again on retry
 * (exit 0). A claim made once cleanup removed `stdin` is too late (exit 3).
 * Neither made nor found: try again later (exit 4).
 */
export const CLAIM_SCRIPT = [
  'd=$1; me=$2',
  `if mkdir "$d/${SETTLED_DIR}" 2>/dev/null; then`,
  `  printf '%s' "$me" > "$d/${SETTLED_BY}"`,
  '  [ -e "$d/stdin" ] && exit 0',
  '  exit 3',
  'fi',
  `[ "$(cat "$d/${SETTLED_BY}" 2>/dev/null)" = "$me" ] && exit 0`,
  `[ -d "$d/${SETTLED_DIR}" ] && exit 3`,
  '[ -d "$d" ] || exit 3',
  'exit 4',
].join('\n')

export function claimArgv(dir: string, claimant: string): string[] {
  return ['/bin/sh', '-c', CLAIM_SCRIPT, 'plannotator-claim', dir, claimant]
}

/**
 * Prints each launch directory whose stored record can go. Arguments are
 * directories in three groups, each started by a marker:
 * - `--cleaned`: only when settled or cleaned up (no `stdin` — which the mod
 *   writes before launching and only `cleanupArgv` removes — or no directory
 *   at all; or a `settled/` claim marked delivered or reported, or with no
 *   decision on disk). A claimed decision never marked delivered stays, so
 *   its session can report it when resumed (`UNDELIVERED_AFTER_MS`);
 * - `--dead`: also when no decision waits (`result.json`, `exit`) and the
 *   server's pid no longer answers `kill -0` (or there is none);
 * - `--expired`: also with a decision waiting, unless the server still runs
 *   (a session nobody resumed for a long time).
 * A live server always keeps its record.
 */
export const PRUNE_SCRIPT = [
  'mode=cleaned',
  'for d in "$@"; do',
  '  case "$d" in --cleaned|--dead|--expired) mode=${d#--}; continue ;; esac',
  '  if [ ! -e "$d/stdin" ]; then echo "$d"; continue; fi',
  `  if [ -e "$d/${SETTLED_DIR}" ]; then`,
  // Delivered, reported, or a claim on a server that stopped without a decision.
  `    if [ -e "$d/${SETTLED_DIR}/delivered" ] || [ -e "$d/${SETTLED_DIR}/reported" ] || { [ ! -e "$d/result.json" ] && [ ! -e "$d/exit" ]; }; then echo "$d"; continue; fi`,
  // Claimed and maybe never delivered: kept until its session reports it, or it expires.
  '    [ "$mode" = expired ] || continue',
  '  fi',
  '  [ "$mode" = cleaned ] && continue',
  '  pid=$(cat "$d/pid" 2>/dev/null)',
  '  case "$pid" in',
  '    "") alive=0 ;;',
  '    *[!0-9]*) alive=1 ;;',
  '    *) if kill -0 "$pid" 2>/dev/null; then alive=1; else alive=0; fi ;;',
  '  esac',
  '  [ "$alive" = 1 ] && continue',
  '  if [ "$mode" = dead ]; then',
  '    for f in result.json exit; do [ -e "$d/$f" ] && continue 2; done',
  '  fi',
  '  echo "$d"',
  'done',
].join('\n')

export function pruneArgv(groups: { cleaned: readonly string[]; dead: readonly string[]; expired: readonly string[] }): string[] {
  return [
    '/bin/sh',
    '-c',
    PRUNE_SCRIPT,
    'plannotator-prune',
    '--cleaned',
    ...groups.cleaned,
    '--dead',
    ...groups.dead,
    '--expired',
    ...groups.expired,
  ]
}

/** Above this the debug log is moved to `<file>.1` before the next append. */
export const DEBUG_LOG_MAX_BYTES = 1_048_576

/**
 * Appends stdin to the debug log, rotating it once it passes
 * `DEBUG_LOG_MAX_BYTES`. Appending (O_APPEND) is what lets several Claude Code
 * processes share one log: rewriting the whole file from each process's own
 * buffer clobbered the other's lines and could leave NUL bytes behind. The
 * rotation runs under a lock (`<file>.rotating`, mkdir; a lock older than a
 * minute is a dead writer's and is removed) and re-checks the size inside it,
 * so two writers past the limit at once rotate once instead of the second
 * moving the fresh log over the first one's `<file>.1`.
 */
export const DEBUG_APPEND_SCRIPT = [
  'f=$1; lock="$f.rotating"',
  'mkdir -p "$(dirname "$f")" 2>/dev/null',
  `size() { s=$(wc -c < "$f" 2>/dev/null | tr -d ' '); echo "\${s:-0}"; }`,
  `if [ "$(size)" -gt ${DEBUG_LOG_MAX_BYTES} ]; then`,
  '  [ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$lock" 2>/dev/null',
  '  if mkdir "$lock" 2>/dev/null; then',
  `    [ "$(size)" -gt ${DEBUG_LOG_MAX_BYTES} ] && mv -f "$f" "$f.1" 2>/dev/null`,
  '    rmdir "$lock" 2>/dev/null',
  '  fi',
  'fi',
  'cat >> "$f"',
].join('\n')

export function debugAppendArgv(path: string): string[] {
  return ['/bin/sh', '-c', DEBUG_APPEND_SCRIPT, 'plannotator-debug', path]
}

/** Liveness probe through the shell's own `kill` (no /bin/kill on every system). */
export function aliveArgv(pid: string): string[] {
  return ['/bin/sh', '-c', 'kill -0 "$1" 2>/dev/null', 'plannotator-alive', pid]
}

/** Exit codes of `STOP_SCRIPT`. */
export const STOP_EXIT = { stopped: 0, decided: 3, notPlannotator: 4, failed: 5, cannotVerify: 6 } as const

/**
 * Stops a CLI that has no host close endpoint (an older Plannotator) with
 * TERM, which ends the server without a decision and never deletes its draft.
 * `$1` is the pid, the rest are files whose presence means the reviewer
 * already decided (the result record, the exit code): then nothing is sent
 * (exit 3), so that decision is still delivered. The pid must still name a
 * `plannotator` process (exit 4 otherwise), so a pid reused after the CLI
 * died (a reboot, a crash) is never signalled. Where `ps` cannot say (missing,
 * as on Debian slim without procps, or without `-p`, as BusyBox's) nothing is
 * signalled either (exit 6): the check is made on the script's own pid first.
 */
export const STOP_SCRIPT = [
  'pid=$1; shift',
  'for f in "$@"; do [ -e "$f" ] && exit 3; done',
  '[ -n "$(ps -o args= -p $$ 2>/dev/null)" ] || exit 6',
  'ps -o args= -p "$pid" 2>/dev/null | grep -q plannotator || exit 4',
  'kill -TERM "$pid" 2>/dev/null || exit 5',
].join('\n')

export function stopArgv(pid: string, decidedFiles: readonly string[]): string[] {
  return ['/bin/sh', '-c', STOP_SCRIPT, 'plannotator-stop', pid, ...decidedFiles]
}

export function launchDirOf(dataDir: string, sessionId: string, launchId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${dataDir}/claude-code-mod/${safe(sessionId)}/${safe(launchId)}`
}

export interface ReadyInfo {
  url: string
  port: number
  isRemote: boolean
  /** What the server shows, in full, as the CLI resolved it (absent from an older CLI). */
  target?: string | string[]
}

function readyTargetOf(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    return value as string[]
  }
  return undefined
}

/** The first well-formed line of the ready file. */
export function parseReadyFile(text: string): ReadyInfo | null {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (typeof value.url === 'string' && typeof value.port === 'number') {
        const target = readyTargetOf(value.target)
        return { url: value.url, port: value.port, isRemote: value.isRemote === true, ...(target !== undefined ? { target } : {}) }
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

/** A slash command's typed arguments split like its shell line, or words that are already split (a tool call). */
export function wordsOf(args: string | readonly string[]): string[] {
  return typeof args === 'string' ? splitShellWords(args) : [...args]
}

/** The CLI argv for a command, with the user's words passed through unchanged. */
export function cliArgvFor(kind: Exclude<SessionKind, 'plan'>, args: string | readonly string[]): string[] {
  const words = wordsOf(args)
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

/**
 * Whether annotate's words (flags ignored) are several file paths, i.e. a
 * review of several files (the CLI checks they exist; this only reads their
 * shape, for naming the session and for reading an older CLI's refusal).
 */
export function isSeveralFilePaths(words: readonly string[]): boolean {
  const targets = [...new Set(words.filter((word) => !word.startsWith('-')))]
  return targets.length > 1 && targets.every(looksLikeFilePath)
}

/** How the status line, the command output and the plugin turn name a session. */
export function subjectFor(kind: SessionKind, args: string | readonly string[], version?: number): string {
  const words = wordsOf(args).filter((word) => !word.startsWith('-'))
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
      // Several file paths open as one review: name it as a bundle.
      if (isSeveralFilePaths(words)) return plannotatorBundleSubject([...new Set(words)])
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

/**
 * `last`'s subject when the reviewer can pick among several messages: the
 * feedback may be about an older one (its excerpt rides in the feedback).
 */
export const RECENT_MESSAGES_SUBJECT = "Claude's recent messages"

/** The classic `annotate-last` picker's limit (RECENT_MESSAGES_LIMIT in the CLI). */
export const RECENT_MESSAGES_LIMIT = 25
/** The CLI's limits on the messages file (`apps/hook/server/host-messages.ts`): raw text per message. */
export const MAX_PICKER_MESSAGE_BYTES = 2 * 1024 * 1024
/** The CLI's cap on the whole SERIALIZED file. */
export const MAX_PICKER_FILE_BYTES = 8 * 1024 * 1024
/**
 * What the mod lets the serialized file reach: under the CLI's cap with a
 * margin. Measured on the JSON as written, since escaping inflates text
 * (quotes and newlines double, a control character such as ESC becomes
 * `\u001b`, six bytes).
 */
export const PICKER_FILE_BUDGET_BYTES = MAX_PICKER_FILE_BYTES - 256 * 1024

/**
 * The assistant messages that have text, newest first, at most `limit`.
 * Consecutive assistant rows (no user row between them) are one response, so
 * their texts are joined, as the transcript path groups chunks by message id.
 */
export function recentAssistantTexts(
  messages: readonly { role: string; text: string }[],
  limit: number = RECENT_MESSAGES_LIMIT,
): string[] {
  const texts: string[] = []
  let run: string[] = []
  const flush = () => {
    const text = run.join('\n')
    run = []
    if (text.trim()) texts.push(text)
  }
  for (let index = messages.length - 1; index >= 0 && texts.length < limit; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (message.role === 'assistant') {
      if (message.text.trim()) run.unshift(message.text)
    } else {
      flush()
    }
  }
  if (texts.length < limit) flush()
  return texts
}

export interface PickerMessage {
  messageId: string
  text: string
}

export interface PickerFile {
  messages: PickerMessage[]
  /** Exactly what is written to `messages.json`, within PICKER_FILE_BUDGET_BYTES. */
  json: string
}

/**
 * The picker list the CLI reads from `messages.json`: `texts` newest first,
 * each with an id derived from its content (stable across launches, so a
 * message keeps its id as newer ones arrive), and the file text itself. The
 * budget is the serialized size: older messages that would push the file past
 * it (or are over the CLI's per-message limit) are left out. When the newest
 * alone does not fit, the list is empty and the launch hands over stdin alone.
 */
export async function pickerFile(
  texts: readonly string[],
  sha256: (text: string) => Promise<string>,
  budgetBytes: number = PICKER_FILE_BUDGET_BYTES,
): Promise<PickerFile> {
  const encoder = new TextEncoder()
  const size = (text: string) => encoder.encode(text).length
  const empty = { messages: [], json: JSON.stringify({ v: 1, messages: [] }) }
  const picked: PickerMessage[] = []
  const used = new Map<string, number>()
  // `{"v":1,"messages":[]}`, then each entry's JSON plus a comma between entries.
  let total = size(empty.json)
  for (const [index, text] of texts.entries()) {
    const fits = size(text) <= MAX_PICKER_MESSAGE_BYTES
    const base = fits ? `cc-${(await sha256(text)).slice(0, 16)}` : ''
    const seen = used.get(base) ?? 0
    const message = { messageId: seen === 0 ? base : `${base}-${seen + 1}`, text }
    const cost = size(JSON.stringify(message)) + (picked.length > 0 ? 1 : 0)
    if (!fits || total + cost > budgetBytes) {
      if (index === 0) return empty
      continue
    }
    total += cost
    used.set(base, seen + 1)
    picked.push(message)
  }
  return { messages: picked, json: JSON.stringify({ v: 1, messages: picked }) }
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
