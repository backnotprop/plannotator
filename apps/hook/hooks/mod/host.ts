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

export interface LoadedPluginInfo {
  version: string | null
  root: string | null
  loaded_at: number
}

export interface TimerHandle {
  cancel: () => void
}

export class PromptDropped extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'PromptDropped'
  }
}

export async function submitOrThrow(submit: () => Promise<unknown>): Promise<void> {
  const result = (await submit()) as { drop?: unknown } | null | undefined
  if (result && typeof result === 'object' && 'drop' in result && result.drop !== undefined && result.drop !== null && result.drop !== false) {
    throw new PromptDropped(typeof result.drop === 'string' ? result.drop : '')
  }
}

export interface Host {
  now(): Promise<number>
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  waitForAny(paths: readonly string[], timeoutMs: number): Promise<void>
  every(ms: number, fn: () => void): TimerHandle
  run(argv: readonly string[], init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<ProcessResult>
  readFile(path: string): Promise<string>
  writeFile(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  fileSize(path: string): Promise<number | null>
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  submit(text: string): Promise<void>
  appendUserRow?(text: string): Promise<void>
  sessionAppendAvailable?(): Promise<boolean>
  loadedPlugin?(): Promise<LoadedPluginInfo | null>
  readPrompt?(): Promise<string>
  runReload?(): Promise<unknown>
  engineVersion?(): Promise<string | null>
  appendNotice?(text: string): Promise<void>
  setSessionProject?(value: string): Promise<void>
  suggest(text: string): Promise<void>
  status(text: string | undefined): void
  log(text: string): void
  toast(text: string): void
  messages(): Promise<TranscriptMessage[]>
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<HttpResult>
  abortTurn(turnId: string): Promise<void>
  randomHex(bytes: number): string
  debug(text: string): void
  sha256(text: string): Promise<string>
}
