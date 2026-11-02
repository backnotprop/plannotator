/**
 * What the mod's logic needs from Claude Code, as plain closures over `$`.
 *
 * `register.ts` builds one from the engine's `$` at `session.start`; unit
 * tests (bun) build one from memory. Keeping every `$` call in register.ts is
 * also what `claude plugin validate` needs to follow `$`.
 */

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface HttpResult {
  status: number
  ok: boolean
  text: string
}

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
}

/** What this process loaded: the Inbox poll's `plugin` field. */
export interface LoadedPluginInfo {
  /** plugin.json's version; null when unreadable. */
  version: string | null
  /** The plugin's folder (`$.plugin.root`); null when it could not be read. */
  root: string | null
  /** When the module loaded, ms since the epoch. */
  loaded_at: number
}

export interface TimerHandle {
  cancel: () => void
}

export interface Host {
  now(): Promise<number>
  /**
   * `$.clock.sleep`: counts against a hook's 10 s budget while it waits, so
   * never used inside one, except as a short bound raced against a `$` call
   * (inbox.ts `within`), aborted through `signal` the moment that call settles.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  /**
   * Resolve once any of `paths` exists, or after `timeoutMs`. Waits inside a
   * `$.process.run` call, which (unlike a `$.clock` wait) does not count
   * against a hook's budget.
   */
  waitForAny(paths: readonly string[], timeoutMs: number): Promise<void>
  every(ms: number, fn: () => void): TimerHandle
  run(argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<ProcessResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** Size in bytes, or null when the path is not a regular file. */
  fileSize(path: string): Promise<number | null>
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  /** `$.prompt.submit`: runs once the session is idle, read under the plugin's name. */
  submit(text: string): Promise<void>
  /**
   * `$.session.append` of a user-role row (the model reads it; the person
   * does not see it as typed): in a running turn it is in the turn's next
   * model request, the one way a plugin puts words into a running turn
   * (`$.prompt.submit` never folds into one). Rejects when the row was
   * refused, or the engine has no `$.session.append`. Optional for hosts
   * (tests) that model an engine without it.
   */
  appendUserRow?(text: string): Promise<void>
  /**
   * Whether this engine has `$.session.append` (a build that documents it;
   * `claude plugin validate` refuses reading `$.session.append` as a value,
   * so it is decided from the engine's version). Absent or false: Send now
   * is never advertised.
   */
  sessionAppendAvailable?(): Promise<boolean>
  /**
   * The plugin this process loaded: its plugin.json version, its folder
   * (`$.plugin.root`) and when the module loaded (ms). Read once per process.
   * The Inbox poll carries it, so the Inbox can say when a restart would
   * load a newer plugin. The engine's host always answers (with null parts
   * when a read failed); optional for test hosts, which then send nothing.
   */
  loadedPlugin?(): Promise<LoadedPluginInfo | null>
  /** Claude Code's own version (`$.session.version()`'s `base`); null when unknown. Optional. */
  engineVersion?(): Promise<string | null>
  /** `$.session.append` of a notice the transcript shows and the model never reads. */
  appendNotice?(text: string): Promise<void>
  /**
   * `$.env.set` of PLANNOTATOR_SESSION_PROJECT (INBOX_SESSION_PROJECT_ENV in
   * inbox.ts), which every process the session starts from then on inherits.
   * Optional: a test host without it exports nothing.
   */
  setSessionProject?(value: string): Promise<void>
  suggest(text: string): Promise<void>
  status(text: string | undefined): void
  log(text: string): void
  toast(text: string): void
  messages(): Promise<TranscriptMessage[]>
  /** `body` absent for a GET. */
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<HttpResult>
  abortTurn(turnId: string): Promise<void>
  randomHex(bytes: number): string
  /** A line in the mod's debug log (PLANNOTATOR_MOD_DEBUG=1); a no-op otherwise. */
  debug(text: string): void
  sha256(text: string): Promise<string>
}
