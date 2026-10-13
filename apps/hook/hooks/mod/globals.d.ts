// The web APIs a Claude Code hooks module has (its environment has no DOM and
// no Node), declared for this folder's typecheck only. Claude Code writes the
// full declarations with `/plugin-types`; they are not vendored here.

declare const crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> }
}

declare class TextEncoder {
  encode(input?: string): Uint8Array
}

declare class AbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
}

declare class AbortController {
  readonly signal: AbortSignal
  abort(): void
}

declare class URL {
  constructor(url: string, base?: string)
  readonly host: string
}
