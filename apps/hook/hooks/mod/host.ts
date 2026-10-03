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

export interface TimerHandle {
  cancel: () => void
}

export interface Host {
  now(): Promise<number>
  /** `$.clock.sleep`: counts against a hook's 10 s budget, so never used inside one. */
  sleep(ms: number): Promise<void>
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
  suggest(text: string): Promise<void>
  status(text: string | undefined): void
  log(text: string): void
  toast(text: string): void
  messages(): Promise<TranscriptMessage[]>
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<HttpResult>
  abortTurn(turnId: string): Promise<void>
  randomHex(bytes: number): string
  /** A line in the mod's debug log (PLANNOTATOR_MOD_DEBUG=1); a no-op otherwise. */
  debug(text: string): void
  sha256(text: string): Promise<string>
}
