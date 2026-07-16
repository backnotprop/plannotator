import type { PRContext, PRRef } from "./pr-types";

export type PRContextRefreshReason =
  | "warm"
  | "watch"
  | "poll"
  | "timer"
  | "write"
  | "queued";

export type PRContextStreamEvent =
  | {
      readonly type: "snapshot";
      readonly url: string;
      readonly version: number;
      readonly context: PRContext | null;
      readonly loading: boolean;
      readonly error: string | null;
      readonly stale: boolean;
      readonly retryAt?: number;
    }
  | {
      readonly type: "updated";
      readonly url: string;
      readonly version: number;
      readonly context: PRContext;
      readonly stale: false;
    }
  | {
      readonly type: "loading";
      readonly url: string;
      readonly version: number;
    }
  | {
      readonly type: "error";
      readonly url: string;
      readonly version: number;
      readonly error: string;
      readonly stale: boolean;
      readonly retryAt?: number;
    };

export type PRContextSubscriber = (event: PRContextStreamEvent) => void;

type TimerHandle = unknown;

type PRContextCacheEntry = {
  url: string;
  ref: PRRef;
  context: PRContext | null;
  error: string | null;
  version: number;
  inflight: Promise<PRContext> | null;
  watchers: number;
  subscribers: Set<PRContextSubscriber>;
  timer: TimerHandle | null;
  lastSuccessAt: number;
  nextAllowedRefreshAt: number;
  refreshAfterInflight: boolean;
};

export type PRContextLiveCacheOptions = {
  readonly fetchContext: (ref: PRRef) => Promise<PRContext>;
  readonly refreshIntervalMs?: number;
  readonly failureCooldownMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  readonly clearTimer?: (timer: TimerHandle) => void;
};

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 60_000;

export const PR_CONTEXT_HEARTBEAT_COMMENT = ": heartbeat\n\n";
export const PR_CONTEXT_HEARTBEAT_INTERVAL_MS = 15_000;

/** Serialize one PR context stream event using the EventSource wire format. */
export function serializePRContextSSEEvent(event: PRContextStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Create a session-local live cache for PR context snapshots and subscribers. */
export function createPRContextLiveCache(
  options: PRContextLiveCacheOptions,
): PRContextLiveCache {
  return new PRContextLiveCache(options);
}

/** Owns live PR context freshness for one review-server session. */
export class PRContextLiveCache {
  private readonly fetchContext: (ref: PRRef) => Promise<PRContext>;
  private readonly refreshIntervalMs: number;
  private readonly failureCooldownMs: number;
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly entries = new Map<string, PRContextCacheEntry>();

  constructor(options: PRContextLiveCacheOptions) {
    this.fetchContext = options.fetchContext;
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.failureCooldownMs =
      options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => {
      // SAFETY: The default setTimer above is the only source of timer handles
      // when a caller does not provide a matching clearTimer.
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    });
  }

  /** Start a best-effort background refresh without waiting on it. */
  warm(url: string, ref: PRRef): void {
    this.runDetached(this.refresh(url, ref, "warm"), "warm");
  }

  /** Refresh immediately after a successful provider write. */
  refreshAfterWrite(url: string, ref: PRRef): void {
    this.runDetached(
      this.refresh(url, ref, "write", { force: true, queueAfterInflight: true }),
      "write",
    );
  }

  /** Return the latest context, sharing any in-flight provider refresh. */
  async getContext(url: string, ref: PRRef): Promise<PRContext> {
    const entry = this.ensureEntry(url, ref);
    if (!this.shouldRefresh(entry)) {
      if (entry.inflight) return entry.inflight;
      if (entry.context) return entry.context;
      throw new Error(entry.error ?? "PR context is unavailable");
    }

    try {
      return await this.refresh(url, ref, "poll");
    } catch (cause: unknown) {
      if (entry.context) return entry.context;
      throw cause;
    }
  }

  /** Subscribe to live updates for a PR URL until the returned cleanup runs. */
  watch(url: string, ref: PRRef, subscriber: PRContextSubscriber): () => void {
    const entry = this.ensureEntry(url, ref);
    entry.watchers += 1;
    entry.subscribers.add(subscriber);
    const unsubscribe = (): void => {
      this.removeSubscriber(entry, subscriber);
    };

    try {
      subscriber(this.snapshotEvent(entry));
    } catch {
      unsubscribe();
      return unsubscribe;
    }

    if (this.shouldRefresh(entry)) {
      this.runDetached(this.refresh(url, ref, "watch"), "watch");
    }
    this.scheduleNext(entry);

    return unsubscribe;
  }

  private ensureEntry(url: string, ref: PRRef): PRContextCacheEntry {
    const existing = this.entries.get(url);
    if (existing) {
      existing.ref = ref;
      return existing;
    }

    const entry: PRContextCacheEntry = {
      url,
      ref,
      context: null,
      error: null,
      version: 0,
      inflight: null,
      watchers: 0,
      subscribers: new Set(),
      timer: null,
      lastSuccessAt: 0,
      nextAllowedRefreshAt: 0,
      refreshAfterInflight: false,
    };
    this.entries.set(url, entry);
    return entry;
  }

  private shouldRefresh(entry: PRContextCacheEntry): boolean {
    if (entry.inflight) return false;
    const now = this.now();
    if (now < entry.nextAllowedRefreshAt) return false;
    if (!entry.context) return true;
    return now - entry.lastSuccessAt >= this.refreshIntervalMs;
  }

  private refresh(
    url: string,
    ref: PRRef,
    reason: PRContextRefreshReason,
    options?: {
      readonly force?: boolean;
      readonly queueAfterInflight?: boolean;
    },
  ): Promise<PRContext> {
    const entry = this.ensureEntry(url, ref);
    if (entry.inflight) {
      if (options?.queueAfterInflight) entry.refreshAfterInflight = true;
      return entry.inflight;
    }

    const now = this.now();
    if (!options?.force && now < entry.nextAllowedRefreshAt) {
      if (entry.context) return Promise.resolve(entry.context);
      return Promise.reject(new Error(entry.error ?? "PR context refresh is paused"));
    }

    this.clearScheduledTimer(entry);
    this.broadcast(entry, { type: "loading", url, version: entry.version });

    const promise = Promise.resolve()
      .then(() => this.fetchContext(ref))
      .then((context) => {
        entry.context = context;
        entry.error = null;
        entry.lastSuccessAt = this.now();
        entry.nextAllowedRefreshAt = 0;
        entry.version += 1;
        this.broadcast(entry, {
          type: "updated",
          url,
          version: entry.version,
          context,
          stale: false,
        });
        return context;
      })
      .catch((cause: unknown) => {
        const message = messageFromUnknown(cause);
        const retryAt = this.now() + this.failureCooldownMs;
        entry.error = message;
        entry.nextAllowedRefreshAt = retryAt;
        entry.version += 1;
        this.broadcast(entry, {
          type: "error",
          url,
          version: entry.version,
          error: message,
          stale: entry.context !== null,
          retryAt,
        });
        throw cause;
      })
      .finally(() => {
        entry.inflight = null;
        if (entry.refreshAfterInflight) {
          entry.refreshAfterInflight = false;
          this.runDetached(
            this.refresh(entry.url, entry.ref, "queued", {
              force: true,
              queueAfterInflight: true,
            }),
            reason,
          );
        }
        this.scheduleNext(entry);
      });

    entry.inflight = promise;
    return promise;
  }

  private snapshotEvent(entry: PRContextCacheEntry): PRContextStreamEvent {
    return {
      type: "snapshot",
      url: entry.url,
      version: entry.version,
      context: entry.context,
      loading: entry.inflight !== null,
      error: entry.error,
      stale: entry.error !== null && entry.context !== null,
      ...(entry.nextAllowedRefreshAt > this.now()
        ? { retryAt: entry.nextAllowedRefreshAt }
        : {}),
    };
  }

  private broadcast(
    entry: PRContextCacheEntry,
    event: PRContextStreamEvent,
  ): void {
    for (const subscriber of entry.subscribers) {
      try {
        subscriber(event);
      } catch {
        this.removeSubscriber(entry, subscriber);
      }
    }
  }

  private scheduleNext(entry: PRContextCacheEntry): void {
    if (entry.watchers === 0 || entry.timer !== null) return;

    const now = this.now();
    const nextRefreshAt =
      entry.nextAllowedRefreshAt > now
        ? entry.nextAllowedRefreshAt
        : now + this.refreshIntervalMs;
    const delayMs = Math.max(0, nextRefreshAt - now);

    entry.timer = this.setTimer(() => {
      entry.timer = null;
      this.runDetached(this.refresh(entry.url, entry.ref, "timer"), "timer");
    }, delayMs);
  }

  private clearScheduledTimer(entry: PRContextCacheEntry): void {
    if (!entry.timer) return;
    this.clearTimer(entry.timer);
    entry.timer = null;
  }

  private removeSubscriber(
    entry: PRContextCacheEntry,
    subscriber: PRContextSubscriber,
  ): void {
    if (!entry.subscribers.delete(subscriber)) return;
    entry.watchers = Math.max(0, entry.watchers - 1);
    if (entry.watchers === 0) this.clearScheduledTimer(entry);
  }

  private runDetached(
    promise: Promise<unknown>,
    _reason: PRContextRefreshReason,
  ): void {
    void promise.catch(() => {
      // refresh() records the failure and broadcasts it; no extra logging hook
      // exists in this shared module.
    });
  }
}

function messageFromUnknown(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause;
  return "Failed to refresh PR context";
}
