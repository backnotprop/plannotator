import { InboxApiError } from './apiError';

const mint = (prefix: string) => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${prefix}-${Date.now()}-${Math.random()}`);

/** A 4xx answer. A linked machine's door keeps every answer under 500 per key, so it would replay this one. */
export function isRefusal(cause: unknown): boolean {
  return cause instanceof InboxApiError && cause.status >= 400 && cause.status < 500;
}

/**
 * The idempotency keys of one dialog's press (Combine, Tidy), one per part: this machine (`null`) or a linked one.
 * A press again after a network error, a 5xx or a held write sends the same key, so it answers the same run; after a
 * refusal that part gets a new key, so a changed pick is not answered with the kept refusal.
 */
export class PressKeys {
  private readonly root: string;
  private readonly fresh = new Map<string | null, string>();

  constructor(
    private readonly prefix: string,
    first?: string,
  ) {
    this.root = first ?? mint(prefix);
  }

  /** The key for one part: a linked machine's carries its id, as each machine keeps its own. */
  for(part: string | null = null): string {
    const base = this.fresh.get(part) ?? this.root;
    return part === null ? base : `${base}-${part}`;
  }

  /** After a part's press failed: a refusal frees its key for the next press. */
  failed(part: string | null, cause: unknown): void {
    if (isRefusal(cause)) this.fresh.set(part, mint(this.prefix));
  }
}
