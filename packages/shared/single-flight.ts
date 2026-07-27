/**
 * Coalesce concurrent async work for the same key without caching its result.
 * A different key starts independently, and a settled operation is never reused.
 */
export class SingleFlight<T> {
  private active: { key: string; promise: Promise<T> } | null = null;

  /** Run an operation or join the currently running operation for the same key. */
  async run(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.active;
    if (existing?.key === key) return existing.promise;

    const promise = operation();
    this.active = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.active?.promise === promise) this.active = null;
    }
  }

  /** Stop new callers from joining the current operation. The operation itself continues. */
  clear(): void {
    this.active = null;
  }
}
