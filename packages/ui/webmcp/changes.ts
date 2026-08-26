/**
 * The change tracker behind "since your last read".
 *
 * WebMCP page tools receive no caller identity and the spec's model is one
 * agent per tab, so the watermark is per tab, per page load, and any agent
 * that wants its own passes `since` explicitly (every response returns
 * `cursor`). Two agents on one tab share the implicit watermark; that is a
 * documented limitation.
 *
 * Pure, no DOM, so it can move to `@plannotator/core` untouched.
 */

/** `source` stamped on every annotation a browser agent creates through the tools. */
export const BROWSER_AGENT_SOURCE = 'browser-agent';

/** The slice of an annotation the tracker hashes. */
export interface TrackedAnnotation {
  id: string;
  text?: string;
  originalText?: string;
  source?: string;
  inReplyTo?: string;
  images?: ReadonlyArray<{ path: string }>;
}

export interface ChangeEntry {
  seq: number;
  hash: string;
  agent: boolean;
}

export interface Tombstone {
  id: string;
  seq: number;
  /** The removed annotation was agent-authored (its `source` was the agent stamp). */
  agent: boolean;
}

export interface ObserveDelta {
  added: string[];
  changed: string[];
  removed: Tombstone[];
}

export function isAgentAnnotation(annotation: { source?: string }): boolean {
  return annotation.source === BROWSER_AGENT_SOURCE;
}

export function hashAnnotation(annotation: TrackedAnnotation): string {
  return JSON.stringify([
    annotation.text ?? '',
    annotation.originalText ?? '',
    annotation.inReplyTo ?? '',
    annotation.images?.map((image) => image.path) ?? [],
  ]);
}

const CURSOR_PREFIX = 'w:';

export class AnnotationChangeTracker {
  private readonly entries = new Map<string, ChangeEntry>();
  private readonly tombstones = new Map<string, Tombstone>();
  /** Hash the agent wrote for an id; the seq assigned to that exact state is never "new" to the agent. */
  private readonly ownHashes = new Map<string, string>();
  private readonly ownSeqs = new Map<string, number>();
  /** Ids the agent removed itself; their tombstones are never reported back to it. */
  private readonly agentRemoved = new Set<string>();
  private counter = 0;
  private mark = 0;
  /** Wall-clock time of the last seq change (null until anything changes). */
  lastActivity: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Highest seq handed out so far. */
  get seq(): number {
    return this.counter;
  }

  /** The implicit per-tab watermark. */
  get watermark(): number {
    return this.mark;
  }

  cursor(): string {
    return `${CURSOR_PREFIX}${this.counter}`;
  }

  /** Accepts a `cursor` string (`w:47`) or a bare number; anything else is null. */
  static parseSince(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
    if (typeof value === 'string') {
      const digits = value.startsWith(CURSOR_PREFIX) ? value.slice(CURSOR_PREFIX.length) : value;
      if (/^\d+$/.test(digits)) return Number(digits);
    }
    return null;
  }

  /** Advance the implicit watermark (default: to the current seq). */
  advance(to: number = this.counter): void {
    this.mark = Math.max(this.mark, Math.min(to, this.counter));
  }

  /**
   * Claim an annotation state as the agent's own: when the tracker next sees
   * this id with this exact hash, that seq is remembered so `newSince` skips
   * it. A later human edit produces a different hash, a new seq, and IS new.
   */
  claimOwn(annotation: TrackedAnnotation): void {
    this.ownHashes.set(annotation.id, hashAnnotation(annotation));
    const entry = this.entries.get(annotation.id);
    if (entry && entry.hash === this.ownHashes.get(annotation.id)) this.ownSeqs.set(annotation.id, entry.seq);
  }

  /**
   * Record that the agent removed `id` itself, so the resulting tombstone
   * is not attributed to the human (`removedSince` skips it).
   */
  claimRemoved(id: string): void {
    this.agentRemoved.add(id);
  }

  /** One O(n) pass over the current list; assigns seqs and tombstones. */
  observe(list: ReadonlyArray<TrackedAnnotation>): ObserveDelta {
    const delta: ObserveDelta = { added: [], changed: [], removed: [] };
    const seen = new Set<string>();
    let touched = false;
    for (const annotation of list) {
      seen.add(annotation.id);
      const hash = hashAnnotation(annotation);
      const agent = isAgentAnnotation(annotation);
      const existing = this.entries.get(annotation.id);
      if (existing && existing.hash === hash) {
        existing.agent = agent;
        continue;
      }
      const seq = ++this.counter;
      touched = true;
      this.entries.set(annotation.id, { seq, hash, agent });
      this.tombstones.delete(annotation.id);
      if (existing) delta.changed.push(annotation.id);
      else delta.added.push(annotation.id);
      if (this.ownHashes.get(annotation.id) === hash) this.ownSeqs.set(annotation.id, seq);
    }
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      this.entries.delete(id);
      const seq = ++this.counter;
      touched = true;
      const tombstone: Tombstone = { id, seq, agent: entry.agent || this.ownHashes.has(id) };
      this.tombstones.set(id, tombstone);
      delta.removed.push(tombstone);
    }
    // A re-added id is a fresh record: forget any agent-removal claim on it.
    for (const id of seen) this.agentRemoved.delete(id);
    if (touched) this.lastActivity = this.now();
    return delta;
  }

  seqOf(id: string): number | undefined {
    return this.entries.get(id)?.seq;
  }

  /** Whether `id` changed after `since` in a way the agent did not author. */
  isNew(id: string, since: number = this.mark): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.seq <= since) return false;
    return this.ownSeqs.get(id) !== entry.seq;
  }

  /** Ids added or edited after `since`, excluding states the agent wrote. */
  newSince(since: number = this.mark): string[] {
    const ids: string[] = [];
    for (const [id] of this.entries) if (this.isNew(id, since)) ids.push(id);
    return ids;
  }

  /** Tombstones written after `since`, excluding removals the agent made itself. */
  removedSince(since: number = this.mark): Tombstone[] {
    const removed: Tombstone[] = [];
    for (const tombstone of this.tombstones.values()) {
      if (tombstone.seq > since && !this.agentRemoved.has(tombstone.id)) removed.push(tombstone);
    }
    return removed;
  }

  /**
   * Whether the agent claimed `id` in this page load. This is the ownership
   * key for update/remove: a `source` stamp alone can be forged through the
   * external-annotations API, a claim cannot.
   */
  isOwn(id: string): boolean {
    return this.ownHashes.has(id);
  }

  /** Whether the tracker has ever seen `id` (live or removed). */
  knows(id: string): boolean {
    return this.entries.has(id) || this.tombstones.has(id);
  }
}

/**
 * Per-path trackers for folder and linked-doc sessions, each with its own
 * read watermark so `newSinceLastRead` is per document.
 */
export class ChangeTrackerSet {
  private readonly trackers = new Map<string, AnnotationChangeTracker>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  forPath(path: string): AnnotationChangeTracker {
    let tracker = this.trackers.get(path);
    if (!tracker) {
      tracker = new AnnotationChangeTracker(this.now);
      this.trackers.set(path, tracker);
    }
    return tracker;
  }

  has(path: string): boolean {
    return this.trackers.has(path);
  }

  paths(): string[] {
    return [...this.trackers.keys()];
  }
}
