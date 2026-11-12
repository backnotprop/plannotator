import type { AISession, AIContextMode } from "./types.ts";

export interface SessionEntry {
  session: AISession;
  mode: AIContextMode;
  parentSessionId: string | null;
  createdAt: number;
  lastActiveAt: number;
  label?: string;
}

export interface SessionManagerOptions {
  maxSessions?: number;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private aliases = new Map<string, string>();
  private maxSessions: number;

  constructor(options: SessionManagerOptions = {}) {
    this.maxSessions = options.maxSessions ?? 20;
  }

  track(session: AISession, mode: AIContextMode, label?: string): SessionEntry {
    this.evictIfNeeded();

    const entry: SessionEntry = {
      session,
      mode,
      parentSessionId: session.parentSessionId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      label,
    };
    this.sessions.set(session.id, entry);

    session.onIdResolved = (oldId, newId) => this.remapId(oldId, newId);

    return entry;
  }

  remapId(oldId: string, newId: string): void {
    const entry = this.sessions.get(oldId);
    if (entry) {
      this.sessions.delete(oldId);
      this.sessions.set(newId, entry);
      this.aliases.set(oldId, newId);
    }
  }

  private resolve(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId;
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(this.resolve(sessionId));
  }

  touch(sessionId: string): void {
    const entry = this.sessions.get(this.resolve(sessionId));
    if (entry) {
      entry.lastActiveAt = Date.now();
    }
  }

  remove(sessionId: string): void {
    const canonical = this.resolve(sessionId);
    const entry = this.sessions.get(canonical);
    this.sessions.delete(canonical);
    entry?.session.dispose?.();
    for (const [alias, target] of this.aliases) {
      if (target === canonical) this.aliases.delete(alias);
    }
  }

  list(): SessionEntry[] {
    return [...this.sessions.values()].sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt
    );
  }

  forksOf(parentSessionId: string): SessionEntry[] {
    return this.list().filter(
      (e) => e.parentSessionId === parentSessionId
    );
  }

  get size(): number {
    return this.sessions.size;
  }

  disposeAll(): void {
    for (const entry of this.sessions.values()) {
      if (entry.session.isActive) {
        entry.session.abort();
      }
      entry.session.dispose?.();
    }
    this.sessions.clear();
    this.aliases.clear();
  }

  private evictIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;

    let oldest: { id: string; at: number } | null = null;
    for (const [id, entry] of this.sessions) {
      if (entry.session.isActive) continue;
      if (!oldest || entry.lastActiveAt < oldest.at) {
        oldest = { id, at: entry.lastActiveAt };
      }
    }

    if (oldest) {
      const entry = this.sessions.get(oldest.id);
      this.sessions.delete(oldest.id);
      entry?.session.dispose?.();
      for (const [alias, target] of this.aliases) {
        if (target === oldest.id) this.aliases.delete(alias);
      }
    }
  }
}
