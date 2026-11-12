export const BROWSER_AGENT_SOURCE = 'browser-agent';

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

export const MAX_TOMBSTONES = 2000;

export class AnnotationChangeTracker {
  private readonly entries = new Map<string, ChangeEntry>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly ownHashes = new Map<string, string>();
  private readonly ownSeqs = new Map<string, number>();
  private readonly agentRemoved = new Set<string>();
  private counter = 0;
  private mark = 0;
  lastActivity: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  get seq(): number {
    return this.counter;
  }

  get watermark(): number {
    return this.mark;
  }

  cursor(): string {
    return `${CURSOR_PREFIX}${this.counter}`;
  }

  static parseSince(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
    if (typeof value === 'string') {
      const digits = value.startsWith(CURSOR_PREFIX) ? value.slice(CURSOR_PREFIX.length) : value;
      if (/^\d+$/.test(digits)) return Number(digits);
    }
    return null;
  }

  advance(to: number = this.counter): void {
    this.mark = Math.max(this.mark, Math.min(to, this.counter));
  }

  claimOwn(annotation: TrackedAnnotation): void {
    this.ownHashes.set(annotation.id, hashAnnotation(annotation));
    const entry = this.entries.get(annotation.id);
    if (entry && entry.hash === this.ownHashes.get(annotation.id)) this.ownSeqs.set(annotation.id, entry.seq);
  }

  claimRemoved(id: string): void {
    this.agentRemoved.add(id);
  }

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
    this.pruneTombstones();
    for (const id of seen) this.agentRemoved.delete(id);
    if (touched) this.lastActivity = this.now();
    return delta;
  }

  private pruneTombstones(): void {
    while (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
      this.ownHashes.delete(oldest);
      this.ownSeqs.delete(oldest);
      this.agentRemoved.delete(oldest);
    }
  }

  seqOf(id: string): number | undefined {
    return this.entries.get(id)?.seq;
  }

  isNew(id: string, since: number = this.mark): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.seq <= since) return false;
    return this.ownSeqs.get(id) !== entry.seq;
  }

  newSince(since: number = this.mark): string[] {
    const ids: string[] = [];
    for (const [id] of this.entries) if (this.isNew(id, since)) ids.push(id);
    return ids;
  }

  removedSince(since: number = this.mark): Tombstone[] {
    const removed: Tombstone[] = [];
    for (const tombstone of this.tombstones.values()) {
      if (tombstone.seq > since && !this.agentRemoved.has(tombstone.id)) removed.push(tombstone);
    }
    return removed;
  }

  isOwn(id: string): boolean {
    return this.ownHashes.has(id);
  }

  knows(id: string): boolean {
    return this.entries.has(id) || this.tombstones.has(id);
  }
}

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
