export class SingleFlight<T> {
  private active: { key: string; promise: Promise<T> } | null = null;

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

  clear(): void {
    this.active = null;
  }
}
