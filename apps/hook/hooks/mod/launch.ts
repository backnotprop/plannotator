import type { SessionKind } from './delivery'
import { isAbsolutePath, trimTrailingSeparators } from './paths'
import { onWindows, shellArgv } from './shell'
import { splitShellWords } from './shell-words'
import { PLAN_APPROVALS_DIR } from './plan'
import { looksLikeFilePath, plannotatorBundleSubject, plannotatorTargetSubject, type PlannotatorTarget } from './tool'

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

export const SETTLED_DIR = 'settled'
export const SETTLED_BY = 'settled/by'

export function fileIn(dir: string, name: keyof typeof LAUNCH_FILES): string {
  return `${dir}/${LAUNCH_FILES[name]}`
}

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

export function waitArgv(paths: readonly string[], timeoutMs: number): string[] {
  return shellArgv('wait', WAIT_SCRIPT, 'plannotator-wait', [String(Math.max(1, Math.ceil(timeoutMs / 100))), ...paths])
}

export function launchArgv(dir: string, cliArgv: readonly string[]): string[] {
  return shellArgv('launch', LAUNCH_SCRIPT, 'plannotator-launch', [dir, ...cliArgv])
}

export const DATA_DIR_MARKERS = ['history', 'sessions', 'drafts', 'inbox', 'claude-code-mod', 'install-flags.json'] as const

export function dataDirOf(env: {
  home?: string
  dataDir?: string
  xdgDataHome?: string
  legacyExists?: boolean
  legacyHoldsData?: boolean
  xdgHoldsData?: boolean
}): string | null {
  const home = env.home?.replace(/[\\/]+$/, '')
  const custom = env.dataDir?.trim()
  if (custom) {
    if (custom === '~') return home ?? null
    if (custom.startsWith('~/') || custom.startsWith('~\\')) return home ? `${home}/${custom.slice(2)}` : null
    if (isAbsolutePath(custom)) return trimTrailingSeparators(custom)
    return null
  }
  if (!home) return null
  const legacy = `${home}/.plannotator`
  const xdgHome = env.xdgDataHome?.trim()
  const xdg = xdgHome && isAbsolutePath(xdgHome) ? `${xdgHome.replace(/[\\/]+$/, '')}/plannotator` : null
  if (env.legacyExists) return xdg && env.xdgHoldsData && !env.legacyHoldsData ? xdg : legacy
  return xdg ?? legacy
}

export async function resolveDataDir(
  env: { home?: string; dataDir?: string; xdgDataHome?: string },
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const home = env.home?.replace(/[\\/]+$/, '')
  if (env.dataDir?.trim() || !home) return dataDirOf(env)
  const legacy = `${home}/.plannotator`
  const legacyExists = await exists(legacy)
  const xdgHome = env.xdgDataHome?.trim()
  if (!legacyExists || !xdgHome || !isAbsolutePath(xdgHome)) return dataDirOf({ ...env, legacyExists })
  const holdsData = async (dir: string) => {
    for (const entry of DATA_DIR_MARKERS) if (await exists(`${dir}/${entry}`)) return true
    return false
  }
  const xdg = `${xdgHome.replace(/\/+$/, '')}/plannotator`
  const xdgHoldsData = (await exists(xdg)) && (await holdsData(xdg))
  const legacyHoldsData = xdgHoldsData ? await holdsData(legacy) : true
  return dataDirOf({ ...env, legacyExists, xdgHoldsData, legacyHoldsData })
}

export function privateDirArgv(dir: string): string[] {
  return shellArgv('mkdir', 'umask 077 && mkdir -p "$1" && chmod 700 "$1" && pwd', 'plannotator-mkdir', [dir])
}

function normalizeAbsolute(path: string): string {
  const unc = /^\\\\([^\\/]+)[\\/]+([^\\/]+)/.exec(path)
  const root = unc ? `//${unc[1]}/${unc[2]}` : /^[A-Za-z]:/.test(path) ? path.slice(0, 2) : ''
  const out: string[] = []
  for (const segment of path.slice(unc ? unc[0].length : root.length).split(root ? /[\\/]/ : '/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  if (unc) return out.length ? `${root}/${out.join('/')}` : root
  return `${root}/${out.join('/')}`
}

function absoluteWord(word: string): string | undefined {
  const path = word.replace(/^@/, '')
  return isAbsolutePath(path) ? normalizeAbsolute(path) : undefined
}

export function modTargetFor(
  kind: SessionKind,
  args: string | readonly string[],
  cwd: string | undefined,
): string | string[] | undefined {
  const all = wordsOf(args)
  const words: string[] = []
  for (let index = 0; index < all.length; index += 1) {
    const word = all[index] as string
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
      if (words.length === 0) return cwd && isAbsolutePath(cwd) ? normalizeAbsolute(cwd) : undefined
      return words.length === 1 ? absoluteWord(words[0] as string) : undefined
    }
    case 'annotate': {
      if (isSeveralFilePaths(words)) {
        const paths = [...new Set(words)].map(absoluteWord)
        return paths.every((path): path is string => path !== undefined) ? paths : undefined
      }
      if (words.length !== 1) return undefined
      const target = words[0] as string
      if (/^https?:\/\//i.test(target)) return target
      return absoluteWord(target)
    }
  }
}

export function cleanupArgv(dir: string): string[] {
  const names = Object.entries(LAUNCH_FILES)
    .filter(([key]) => key !== 'overflow')
    .map(([, name]) => name)
  return shellArgv(
    'cleanup',
    [
      'dir=$1; shift',
      'for f in "$@"; do rm -f "$dir/$f"; done',
      `if [ ! -e "$dir/${LAUNCH_FILES.overflow}" ]; then rm -f "$dir/${SETTLED_BY}" "$dir/${SETTLED_DIR}/delivered" "$dir/${SETTLED_DIR}/reported"; rmdir "$dir/${SETTLED_DIR}" 2>/dev/null; rmdir "$dir" 2>/dev/null; fi`,
      'exit 0',
    ].join('\n'),
    'plannotator-cleanup',
    [dir, ...names, 'revision.json.ack', 'exit.tmp'],
  )
}

export const CLAIM_EXIT = { won: 0, lost: 3, failed: 4 } as const

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
  return shellArgv('claim', CLAIM_SCRIPT, 'plannotator-claim', [dir, claimant])
}

export const PRUNE_SCRIPT = [
  'mode=cleaned',
  'for d in "$@"; do',
  '  case "$d" in --cleaned|--dead|--expired) mode=${d#--}; continue ;; esac',
  '  if [ ! -e "$d/stdin" ]; then echo "$d"; continue; fi',
  `  if [ -e "$d/${SETTLED_DIR}" ]; then`,
  `    if [ -e "$d/${SETTLED_DIR}/delivered" ] || [ -e "$d/${SETTLED_DIR}/reported" ] || { [ ! -e "$d/result.json" ] && [ ! -e "$d/exit" ]; }; then echo "$d"; continue; fi`,
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
  return shellArgv('prune', PRUNE_SCRIPT, 'plannotator-prune', [
    '--cleaned',
    ...groups.cleaned,
    '--dead',
    ...groups.dead,
    '--expired',
    ...groups.expired,
  ])
}

type PruneGroups = { cleaned: readonly string[]; dead: readonly string[]; expired: readonly string[] }

export const PRUNE_ARGV_BUDGET = 28_000

export function pruneArgvs(groups: PruneGroups, budget = PRUNE_ARGV_BUDGET): string[][] {
  const size = (argv: readonly string[]) => argv.reduce((sum, word) => sum + word.length + 1, 0)
  const empty = (): { cleaned: string[]; dead: string[]; expired: string[] } => ({ cleaned: [], dead: [], expired: [] })
  const base = size(pruneArgv(empty()))
  const batches: Array<ReturnType<typeof empty>> = []
  let batch = empty()
  let used = base
  let count = 0
  for (const mode of ['cleaned', 'dead', 'expired'] as const) {
    for (const dir of groups[mode]) {
      const one = empty()
      one[mode].push(dir)
      const cost = size(pruneArgv(one)) - base
      if (count > 0 && used + cost > budget) {
        batches.push(batch)
        batch = empty()
        used = base
        count = 0
      }
      batch[mode].push(dir)
      used += cost
      count += 1
    }
  }
  if (count > 0) batches.push(batch)
  return batches.map((each) => pruneArgv(each))
}

export const DEBUG_LOG_MAX_BYTES = 1_048_576

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
  return shellArgv('debug-append', DEBUG_APPEND_SCRIPT, 'plannotator-debug', [path])
}

export function aliveArgv(pid: string): string[] {
  return shellArgv('alive', 'kill -0 "$1" 2>/dev/null', 'plannotator-alive', [pid])
}

export const STOP_EXIT = { stopped: 0, decided: 3, notPlannotator: 4, failed: 5, cannotVerify: 6 } as const

export const STOP_SCRIPT = [
  'pid=$1; shift',
  'for f in "$@"; do [ -e "$f" ] && exit 3; done',
  '[ -n "$(ps -o args= -p $$ 2>/dev/null)" ] || exit 6',
  'ps -o args= -p "$pid" 2>/dev/null | grep -q plannotator || exit 4',
  'kill -TERM "$pid" 2>/dev/null || exit 5',
].join('\n')

export function stopArgv(pid: string, decidedFiles: readonly string[]): string[] {
  return shellArgv('stop', STOP_SCRIPT, 'plannotator-stop', [pid, ...decidedFiles])
}

export function planApprovalPathOf(dataDir: string, sessionId: string, toolUseId: string): { dir: string; path: string } {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_')
  const dir = `${dataDir}/claude-code-mod/${safe(sessionId)}/${PLAN_APPROVALS_DIR}`
  return { dir, path: `${dir}/${safe(toolUseId)}.json` }
}

export function removeFileArgv(path: string): string[] {
  return shellArgv('rm', 'rm -f "$1"', 'plannotator-rm', [path])
}

export function launchDirOf(dataDir: string, sessionId: string, launchId: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${dataDir}/claude-code-mod/${safe(sessionId)}/${safe(launchId)}`
}

export interface ReadyInfo {
  url: string
  port: number
  isRemote: boolean
  target?: string | string[]
  tailnet?: { ask: boolean }
}

function readyTargetOf(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    return value as string[]
  }
  return undefined
}

export function parseReadyFile(text: string): ReadyInfo | null {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as Record<string, unknown>
      if (typeof value.url === 'string' && typeof value.port === 'number') {
        const target = readyTargetOf(value.target)
        const tailnet = value.tailnet
        const ask = tailnet && typeof tailnet === 'object' && typeof (tailnet as { ask?: unknown }).ask === 'boolean' ? (tailnet as { ask: boolean }).ask : undefined
        return {
          url: value.url,
          port: value.port,
          isRemote: value.isRemote === true,
          ...(target !== undefined ? { target } : {}),
          ...(ask !== undefined ? { tailnet: { ask } } : {}),
        }
      }
    } catch {
    }
  }
  return null
}

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

export const INBOX_COMMAND = {
  name: 'plannotator-inbox',
  description: 'Open your Plannotator Inbox in the browser, show its address, and brief Claude on using it.',
} as const

export const INBOX_OPEN_TIMEOUT_MS = 30_000

export function inboxOpenArgv(): string[] {
  return ['plannotator', 'inbox', '--open']
}

export function inboxOpened(result: { exitCode: number; stdout: string }): boolean {
  return result.exitCode === 0 && /https?:\/\/\S+/.test(result.stdout)
}

export function inboxOpenAnswer(result: { exitCode: number; stdout: string; stderr: string }): string {
  const url = /https?:\/\/\S+/.exec(result.stdout)?.[0]
  if (result.exitCode === 0 && url) return `Plannotator Inbox: ${url}${result.stderr.trim() ? `\n${result.stderr.trim()}` : ''}`
  const why = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`
  if (/unknown inbox option: --open|unknown command/i.test(why)) {
    return 'The plannotator on PATH is older than /plannotator-inbox. Update it with `plannotator update`, or run `plannotator inbox` in a terminal.'
  }
  return `Could not open the Plannotator Inbox: ${why}`
}

export function isModCommand(name: string): name is CommandName {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name)
}

export function wordsOf(args: string | readonly string[]): string[] {
  return typeof args === 'string' ? splitShellWords(args, { windows: onWindows() }) : [...args]
}

export function cliArgvFor(kind: Exclude<SessionKind, 'plan'>, args: string | readonly string[]): string[] {
  const words = wordsOf(args)
  switch (kind) {
    case 'review':
      return ['plannotator', 'review', ...words]
    case 'annotate':
      return ['plannotator', 'annotate', ...words]
    case 'last':
      return ['plannotator', 'annotate-last', '--stdin', ...(words.includes('--tailscale') ? ['--tailscale'] : [])]
  }
}

const PR_URL = /^https?:\/\/[^\s/]+\/.+\/(?:pull|pull-requests|merge_requests)\/(\d+)\b/i

function baseName(path: string): string {
  if (!onWindows()) {
    const trimmed = path.replace(/\/+$/, '')
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
  }
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed
}

export function isSeveralFilePaths(words: readonly string[]): boolean {
  const targets = [...new Set(words.filter((word) => !word.startsWith('-')))]
  return targets.length > 1 && targets.every(looksLikeFilePath)
}

export const LOCAL_CHANGES_SUBJECT = 'local changes'

export function subjectFromServerTarget(kind: SessionKind, typed: string, target: PlannotatorTarget | undefined): string | null {
  if (kind === 'plan' || kind === 'last') return null
  if (kind === 'review' && typed === LOCAL_CHANGES_SUBJECT) return null
  return plannotatorTargetSubject(kind, target)
}

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
      return directory ? `changes in ${baseName(directory)}` : LOCAL_CHANGES_SUBJECT
    }
    case 'annotate': {
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

export const RECENT_MESSAGES_SUBJECT = "Claude's recent messages"

export const RECENT_MESSAGES_LIMIT = 25
export const MAX_PICKER_MESSAGE_BYTES = 2 * 1024 * 1024
export const MAX_PICKER_FILE_BYTES = 8 * 1024 * 1024
export const PICKER_FILE_BUDGET_BYTES = MAX_PICKER_FILE_BYTES - 256 * 1024

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
  json: string
}

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

export function openedText(kind: SessionKind, subject: string, url: string, extra?: string): string {
  const detail = extra ? ` · ${extra}` : ''
  const second = kind === 'review'
    ? 'Take your time. Feedback comes back here when you send it.'
    : 'Your annotations come back here as a message when you send them.'
  return `Opened ${subject} in Plannotator${detail} · ${url}\n${second}`
}

export function failedText(subject: string, stderr: string, stdout: string, exitCode: number | null): string {
  const output = (stderr.trim() || stdout.trim()).slice(0, 4000)
  const code = exitCode === null ? '' : ` (exit ${exitCode})`
  return output
    ? `Plannotator could not open ${subject}${code}:\n${output}`
    : `Plannotator could not open ${subject}${code}.`
}
