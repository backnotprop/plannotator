/**
 * Windows PowerShell 5.1 as the mod's shell on Windows. It ships with every
 * Windows 10 and 11, so the mod needs nothing else installed. Each POSIX script
 * has a PowerShell twin here with the same arguments, output and exit codes.
 *
 * - The script travels as `-EncodedCommand` (UTF-16, base64): nothing is ever
 *   parsed off a command line, and the execution policy does not apply.
 * - Each argument travels inside it as base64 too, decoded into `$argv`.
 *   Base64 holds no quote, so no argument can end a string early; escaping
 *   `'` would not be enough, since PowerShell also reads `‘ ’ ‚ ‛` as single
 *   quotes.
 * - Output lines end in `\n` alone (`Write-Line`), as the POSIX scripts' do:
 *   the readers split on `\n` and match whole lines.
 * - A pid is a Windows pid, which `Get-Process` and `Stop-Process` take.
 *
 * The scripts are terse on purpose. Each one travels whole on every call, as
 * UTF-16 in base64, so each character costs about 2.7 on the command line,
 * which Windows caps at 32,767 characters. The launch script alone is about
 * 3,000 characters, or 8,000 encoded. So the explanations live in these
 * TypeScript comments, and none sit inside the PowerShell text.
 *
 * The names below (`settled`, `feedback.md`, the debug log's size cap) are
 * launch.ts's; this file imports nothing from it, and powershell.test.ts
 * keeps the two in step.
 */

import type { ModShell, ShellScriptId } from './shell'

/** Runs before every script: stop on errors, UTF-8 output, and the helpers the scripts share. */
const PRELUDE = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
function Write-Line([string]$text) { [Console]::Out.Write($text + [char]10) }
function Join-Child([string]$dir, [string]$name) { [IO.Path]::Combine($dir, $name) }
function Read-Argument([string]$encoded) { [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded)) }
`

const SCRIPTS: Record<ShellScriptId, string> = {
  /** Polls every 100 ms, up to `argv[0]` times, for any of the other paths; exit 0 when one appears, 1 on timeout. */
  wait: String.raw`$tries = [int]$argv[0]
$paths = @($argv | Select-Object -Skip 1)
for ($i = 0; $i -lt $tries; $i++) {
  foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path) { exit 0 }
  }
  Start-Sleep -Milliseconds 100
}
exit 1`,

  /**
   * Starts the CLI detached and returns at once. The CLI runs under a hidden
   * watcher process (`Start-Process`), which puts its streams on the launch
   * directory's files, writes its pid, waits for it, and writes its exit code
   * (127 when it never started) through `exit.tmp` so the `exit` file appears
   * whole. A bare CLI name is looked up as an .exe on `PATH` only: given a
   * bare name, `Process.Start` would also search the session's folder first,
   * so a `plannotator.exe` in a cloned repository would run.
   * `Quote-Argument` quotes each CLI argument the way the Windows
   * command-line parser reads it back; `Write-Value` writes each of the
   * watcher's inputs into its script as base64, decoded where it is read.
   */
  launch: String.raw`function Quote-Argument([string]$text) {
  if ($text -ne '' -and $text -notmatch '[\s"]') { return $text }
  $quoted = '"'
  $slashes = 0
  foreach ($char in $text.ToCharArray()) {
    if ($char -eq '\') {
      $slashes++
      continue
    }
    if ($char -eq '"') {
      $quoted += ('\' * ($slashes * 2 + 1)) + '"'
      $slashes = 0
      continue
    }
    $quoted += ('\' * $slashes) + $char
    $slashes = 0
  }
  $quoted + ('\' * ($slashes * 2)) + '"'
}
function Write-Value([string]$text) { "[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($text)) + "'))" }
$dir = $argv[0]
$exe = $argv[1]
$line = (@($argv | Select-Object -Skip 2) | ForEach-Object { Quote-Argument $_ }) -join ' '
$watcher = '$dir = ' + (Write-Value $dir) + '; $exe = ' + (Write-Value $exe) + '; $line = ' + (Write-Value $line) + [char]10 + @'
$ErrorActionPreference = 'Stop'
$out = [IO.File]::Open([IO.Path]::Combine($dir, 'stdout'), 'Create', 'Write', 'Read')
$err = [IO.File]::Open([IO.Path]::Combine($dir, 'stderr'), 'Create', 'Write', 'Read')
try {
  if (-not [IO.Path]::IsPathRooted($exe)) { $exe = (Get-Command -CommandType Application -Name ([IO.Path]::ChangeExtension($exe, 'exe')) -TotalCount 1).Path }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $exe
  $start.Arguments = $line
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $cli = [System.Diagnostics.Process]::Start($start)
  [IO.File]::WriteAllText([IO.Path]::Combine($dir, 'pid'), [string]$cli.Id)
  $copyOut = $cli.StandardOutput.BaseStream.CopyToAsync($out)
  $copyErr = $cli.StandardError.BaseStream.CopyToAsync($err)
  $stdin = [IO.File]::OpenRead([IO.Path]::Combine($dir, 'stdin'))
  $stdin.CopyTo($cli.StandardInput.BaseStream)
  $stdin.Close()
  $cli.StandardInput.Close()
  $cli.WaitForExit()
  $copyOut.Wait()
  $copyErr.Wait()
  $code = $cli.ExitCode
} catch {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$_ + [char]10)
  $err.Write($bytes, 0, $bytes.Length)
  $code = 127
}
$out.Close()
$err.Close()
[IO.File]::WriteAllText([IO.Path]::Combine($dir, 'exit.tmp'), [string]$code)
Move-Item -Force -LiteralPath ([IO.Path]::Combine($dir, 'exit.tmp')) -Destination ([IO.Path]::Combine($dir, 'exit'))
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watcher))
$null = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded
exit 0`,

  /** Creates the directory `argv[0]` (with its parents) and prints the folder the script runs in, as a Windows path. */
  mkdir: String.raw`$null = [IO.Directory]::CreateDirectory($argv[0])
Write-Line (Get-Location).ProviderPath`,

  /**
   * Removes the named files from the launch directory `argv[0]`. Unless a
   * `feedback.md` is left for the agent to read, it also removes the settled
   * markers and the directory itself.
   */
  cleanup: String.raw`$dir = $argv[0]
foreach ($name in @($argv | Select-Object -Skip 1)) {
  Remove-Item -LiteralPath (Join-Child $dir $name) -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path -LiteralPath (Join-Child $dir 'feedback.md'))) {
  foreach ($name in 'settled\by', 'settled\delivered', 'settled\reported') {
    Remove-Item -LiteralPath (Join-Child $dir $name) -Force -ErrorAction SilentlyContinue
  }
  foreach ($folder in (Join-Child $dir 'settled'), $dir) {
    try { [IO.Directory]::Delete($folder) } catch {}
  }
}
exit 0`,

  /**
   * Claims launch `argv[0]` for claimant `argv[1]`: exit 0 when this claimant
   * holds it, 3 when another does or the launch is gone, 4 on an error. The
   * claim is the `settled\by` file, made with CreateNew so exactly one process
   * wins, where the POSIX script's claim is the mkdir of `settled/`.
   */
  claim: String.raw`$dir = $argv[0]
$me = $argv[1]
$settled = Join-Child $dir 'settled'
$by = Join-Child $settled 'by'
try {
  if (-not [IO.Directory]::Exists($dir)) { exit 3 }
  $null = [IO.Directory]::CreateDirectory($settled)
  $won = $false
  try {
    $file = [IO.File]::Open($by, 'CreateNew', 'Write', 'None')
    $won = $true
  } catch [IO.IOException] {}
  if ($won) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($me)
    $file.Write($bytes, 0, $bytes.Length)
    $file.Close()
    if (Test-Path -LiteralPath (Join-Child $dir 'stdin')) { exit 0 }
    exit 3
  }
  $holder = try { [IO.File]::ReadAllText($by) } catch { '' }
  if ($holder -eq $me) { exit 0 }
  if ([IO.Directory]::Exists($settled)) { exit 3 }
  exit 4
} catch { exit 4 }`,

  /**
   * Prints each launch directory that can go. `--cleaned`, `--dead` and
   * `--expired` set the mode for the directories after them: a directory with
   * no `stdin` always goes; a settled one goes once delivered, reported or
   * undecided (and in `expired` mode, when its CLI is gone); otherwise
   * `dead` and `expired` take the ones whose CLI is no longer running.
   */
  prune: String.raw`$mode = 'cleaned'
foreach ($dir in $argv) {
  if ($dir -eq '--cleaned' -or $dir -eq '--dead' -or $dir -eq '--expired') {
    $mode = $dir.Substring(2)
    continue
  }
  if (-not (Test-Path -LiteralPath (Join-Child $dir 'stdin'))) {
    Write-Line $dir
    continue
  }
  $settled = Join-Child $dir 'settled'
  if (Test-Path -LiteralPath $settled) {
    $decided = (Test-Path -LiteralPath (Join-Child $dir 'result.json')) -or (Test-Path -LiteralPath (Join-Child $dir 'exit'))
    if ((Test-Path -LiteralPath (Join-Child $settled 'delivered')) -or (Test-Path -LiteralPath (Join-Child $settled 'reported')) -or -not $decided) {
      Write-Line $dir
      continue
    }
    if ($mode -ne 'expired') { continue }
  }
  if ($mode -eq 'cleaned') { continue }
  $pidText = try { [IO.File]::ReadAllText((Join-Child $dir 'pid')).Trim() } catch { '' }
  if ($pidText -eq '') { $alive = $false }
  elseif ($pidText -notmatch '^\d+$') { $alive = $true }
  else { $alive = [bool](Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue) }
  if ($alive) { continue }
  if ($mode -eq 'dead' -and ((Test-Path -LiteralPath (Join-Child $dir 'result.json')) -or (Test-Path -LiteralPath (Join-Child $dir 'exit')))) { continue }
  Write-Line $dir
}
exit 0`,

  /**
   * Appends stdin to the debug log `argv[0]`, first rotating a log over
   * 1 MiB to `.1`. It copies stdin as bytes: `[Console]::In` would decode it
   * in the system code page, since a process Claude Code starts has no
   * console.
   */
  'debug-append': String.raw`$log = $argv[0]
$null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($log))
if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1048576) {
  try { Move-Item -Force -LiteralPath $log -Destination ($log + '.1') } catch {}
}
$stdin = [Console]::OpenStandardInput()
$buffer = New-Object System.IO.MemoryStream
$stdin.CopyTo($buffer)
$file = [IO.File]::Open($log, 'Append', 'Write', 'ReadWrite')
$buffer.WriteTo($file)
$file.Close()
exit 0`,

  /** Exit 0 when process `argv[0]` runs, 1 when it does not. */
  alive: String.raw`if (Get-Process -Id ([int]$argv[0]) -ErrorAction SilentlyContinue) { exit 0 }
exit 1`,

  /**
   * Ends the CLI `argv[0]`: exit 3 when one of the other paths exists (the
   * session already settled), 4 when that pid is not a plannotator process,
   * 5 when it cannot be stopped, 6 when its command line cannot be read.
   * Windows has no TERM, so the CLI is ended outright, which also leaves no
   * decision and keeps its draft.
   */
  stop: String.raw`$id = 0L
if (-not [long]::TryParse($argv[0], [ref]$id)) { exit 4 }
foreach ($path in @($argv | Select-Object -Skip 1)) {
  if (Test-Path -LiteralPath $path) { exit 3 }
}
try { $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $id) } catch { exit 6 }
if (-not $process -or [string]$process.CommandLine -cnotmatch 'plannotator') { exit 4 }
try { Stop-Process -Id $id -Force } catch { exit 5 }
exit 0`,

  /** Prints `ok`, through a .NET call like the other scripts make, so a locked-down PowerShell fails it. */
  probe: String.raw`$null = [IO.File]::Exists([IO.Path]::Combine('probe', 'ok'))
Write-Line 'ok'`,

  /** Removes the file `argv[0]`, if it is there. */
  rm: String.raw`Remove-Item -LiteralPath $argv[0] -Force -ErrorAction SilentlyContinue
exit 0`,

  /**
   * Reads `argv[2]` bytes of the transcript `argv[1]` from byte `argv[0]` (1
   * based), prints its last 19 custom-title lines (each cut to 4,096
   * characters), then `end:<offset>:<last line's length>`, or `end::` when the
   * file cannot be read. The POSIX script also prints the file's inode
   * (`id:<n>`) so a rewrite under the same name is noticed; NTFS's file id
   * needs a compiled call per read, so here a rewrite is noticed only when the
   * file shrank.
   */
  'transcript-title': String.raw`$start = [int64]$argv[0] - 1
$path = $argv[1]
$length = [int]$argv[2]
try {
  $file = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
  $null = $file.Seek($start, 'Begin')
  $buffer = New-Object byte[] $length
  $got = 0
  while ($got -lt $length) {
    $read = $file.Read($buffer, $got, $length - $got)
    if ($read -le 0) { break }
    $got += $read
  }
  $file.Close()
} catch {
  Write-Line 'end::'
  exit 0
}
$titles = New-Object System.Collections.Generic.List[string]
$offset = 0
$last = ''
$i = 0
while ($i -lt $got) {
  $newline = [Array]::IndexOf($buffer, [byte]10, $i, $got - $i)
  if ($newline -lt 0) { $newline = $got }
  $size = $newline - $i
  $offset += $size + 1
  $last = $size
  $line = [Text.Encoding]::UTF8.GetString($buffer, $i, $size)
  if ($line.Contains('"type":"custom-title"')) { $titles.Add($line.Substring(0, [Math]::Min($line.Length, 4096))) }
  $i = $newline + 1
}
foreach ($title in @($titles | Select-Object -Last 19)) { Write-Line $title }
Write-Line ('end:' + $offset + ':' + $last)
exit 0`,

  /**
   * Prints the first `"forkedFrom":{"sessionId":"<id>"` in the first `argv[1]`
   * bytes of the transcript `argv[0]`, or nothing (no such row, no file).
   */
  'transcript-forked-from': String.raw`$path = $argv[0]
$length = [int]$argv[1]
try {
  $file = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
  $buffer = New-Object byte[] $length
  $got = 0
  while ($got -lt $length) {
    $read = $file.Read($buffer, $got, $length - $got)
    if ($read -le 0) { break }
    $got += $read
  }
  $file.Close()
} catch {
  exit 0
}
$text = [Text.Encoding]::UTF8.GetString($buffer, 0, $got)
$found = [regex]::Match($text, '"forkedFrom":\{"sessionId":"[A-Za-z0-9._-]*"')
if ($found.Success) { Write-Line $found.Value }
exit 0`,

  /**
   * For each `.jsonl` file in the folder `argv[0]`, looks in its last `argv[1]`
   * bytes and prints its last `continued-in` line (cut to 1,024 characters)
   * when no `user` or `assistant` line follows it; at most 200 lines, nothing
   * for a folder that is not there.
   */
  'transcript-continued-in': String.raw`$length = [int]$argv[1]
try { $paths = [IO.Directory]::GetFiles($argv[0], '*.jsonl') } catch { exit 0 }
$shown = 0
foreach ($path in $paths) {
  if ($shown -ge 200) { break }
  try {
    $file = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
    $take = [int][Math]::Min([int64]$length, $file.Length)
    $null = $file.Seek(-$take, 'End')
    $buffer = New-Object byte[] $take
    $got = 0
    while ($got -lt $take) {
      $read = $file.Read($buffer, $got, $take - $got)
      if ($read -le 0) { break }
      $got += $read
    }
    $file.Close()
  } catch {
    continue
  }
  $found = ''
  foreach ($line in [Text.Encoding]::UTF8.GetString($buffer, 0, $got).Split([char]10)) {
    if ($line.Contains('"type":"continued-in"')) { $found = $line.TrimEnd([char]13) }
    elseif ($line.Contains('"type":"user"') -or $line.Contains('"type":"assistant"')) { $found = '' }
  }
  if ($found -ne '') {
    Write-Line $found.Substring(0, [Math]::Min($found.Length, 1024))
    $shown += 1
  }
}
exit 0`,

  /**
   * Claims the Inbox message directory `argv[0]` for claimant `argv[1]`, with
   * the same exit codes and the same CreateNew claim on its `by` file as
   * `claim` above.
   */
  'inbox-claim': String.raw`$dir = $argv[0]
$me = $argv[1]
$by = Join-Child $dir 'by'
try {
  $null = [IO.Directory]::CreateDirectory($dir)
  $won = $false
  try {
    $file = [IO.File]::Open($by, 'CreateNew', 'Write', 'None')
    $won = $true
  } catch [IO.IOException] {}
  if ($won) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($me)
    $file.Write($bytes, 0, $bytes.Length)
    $file.Close()
    exit 0
  }
  $holder = try { [IO.File]::ReadAllText($by) } catch { '' }
  if ($holder -eq $me) { exit 0 }
  if ([IO.Directory]::Exists($dir)) { exit 3 }
  exit 4
} catch { exit 4 }`,

  /** Gives back claimant `argv[1]`'s claim on `argv[0]` by removing it, unless the message was already delivered or reported. */
  'inbox-release': String.raw`$dir = $argv[0]
$me = $argv[1]
$holder = try { [IO.File]::ReadAllText((Join-Child $dir 'by')) } catch { '' }
if ($holder -ne $me) { exit 0 }
if ((Test-Path -LiteralPath (Join-Child $dir 'delivered')) -or (Test-Path -LiteralPath (Join-Child $dir 'reported'))) { exit 0 }
Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
exit 0`,

  /** Prints the folder `argv[1]` names (absolute, or relative to the session folder `argv[0]`; empty for the session folder itself) as a full Windows path; exit 3 when it is not a folder. */
  'inbox-project': String.raw`$cwd = $argv[0]
$given = $argv[1]
try {
  if ($given -eq '') { $folder = $cwd }
  elseif ($given -match '^([A-Za-z]:[\\/]|[\\/])') { $folder = $given }
  else { $folder = Join-Path $cwd $given }
  if (-not [IO.Directory]::Exists($folder)) { exit 3 }
  Write-Line (Resolve-Path -LiteralPath $folder).ProviderPath
} catch { exit 3 }`,
}

/** `text` as PowerShell's `-EncodedCommand` wants it: UTF-16LE, base64. Built by hand: a hooks module has no Buffer. */
export function encodePowerShell(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    bytes.push(unit & 0xff, unit >> 8)
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const [b0, b1 = 0, b2 = 0] = [bytes[i] as number, bytes[i + 1], bytes[i + 2]]
    const chunk = (b0 << 16) | (b1 << 8) | b2
    out += alphabet[(chunk >> 18) & 63]! + alphabet[(chunk >> 12) & 63]!
    out += i + 1 < bytes.length ? alphabet[(chunk >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? alphabet[chunk & 63]! : '='
  }
  return out
}

/** The full script for `id` with `args`: the prelude, the arguments as `$argv`, then the script. */
export function powerShellScript(id: ShellScriptId, args: readonly string[]): string {
  const encoded = args.map((arg) => `(Read-Argument '${encodePowerShell(arg)}')`).join(', ')
  return `${PRELUDE}$argv = @(${encoded})\n${SCRIPTS[id]}\n`
}

/** Runs each script's PowerShell twin in `powershell` (powershell.exe). */
export function powerShellShell(powershell: string): ModShell {
  return {
    argv: (id, _posix, _tag, args) => [powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(powerShellScript(id, args))],
    windows: true,
    name: 'powershell',
  }
}
