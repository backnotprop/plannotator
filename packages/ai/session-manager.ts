/**
 * Session manager — tracks active and historical AI sessions.
 *
 * Each Plannotator server instance (plan review, code review, annotate)
 * gets its own SessionManager. It tracks:
 *
 * - Active sessions (currently streaming or idle but resumable)
 * - The lineage from forked sessions back to their parent
 * - Metadata for UI display (timestamps, mode, status)
 *
 * This is an in-memory store scoped to the server's lifetime. Sessions
 * are not persisted to disk by the manager (the underlying provider
 * handles its own persistence via the agent SDK).
 */

import type { AISession, AIContextMode } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionEntry {
  /** The live session handle (if still active). */
  session: AISession;
  /** What mode this session was created for. */
  mode: AIContextMode;
  /** The parent session ID this was forked from (null if standalone). */
  parentSessionId: string | null;
  /** When this session was created. */
  createdAt: number;
  /** When the last query was sent. */
  lastActiveAt: number;
  /** Short description for UI display (e.g., the user's first question). */
  label?: string;
}

export interface SessionManagerOptions {
  /**
   * Maximum number of sessions to keep in the manager.
   * Oldest idle sessions are evicted when the limit is reached.
   * Default: 20.
   */
  maxSessions?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private aliases = new Map<string, string>();
  private maxSessions: number;

  constructor(options: SessionManagerOptions = {}) {
    this.maxSessions = options.maxSessions ?? 20;
  }

  /**
   * Track a newly created session.
   *
   * If the session supports ID resolution (e.g., the real SDK session ID
   * arrives after the first query), call `remapId()` to update the key.
   */
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

    // Wire up ID remapping so providers can resolve the real session ID later
    session.onIdResolved = (oldId, newId) => this.remapId(oldId, newId);

    return entry;
  }

  /**
   * Remap a session from one ID to another.
   * Used when the real session ID is resolved after initial tracking.
   */
  remapId(oldId: string, newId: string): void {
    const entry = this.sessions.get(oldId);
    if (entry) {
      this.sessions.delete(oldId);
      this.sessions.set(newId, entry);
      // Keep the old ID as an alias so clients using the original ID still work
      this.aliases.set(oldId, newId);
    }
  }

  /** Resolve an alias to the canonical ID, or return the ID as-is. */
  private resolve(sessionId: string): string {
    return this.aliases.get(sessionId) ?? sessionId;
  }

  /**
   * Get a tracked session by ID (or alias).
   */
  get(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(this.resolve(sessionId));
  }

  /**
   * Mark a session as recently active (updates lastActiveAt).
   */
  touch(sessionId: string): void {
    const entry = this.sessions.get(this.resolve(sessionId));
    if (entry) {
      entry.lastActiveAt = Date.now();
    }
  }

  /**
   * Remove a session from tracking.
   * Does NOT abort the session — call session.abort() first if needed.
   */
  remove(sessionId: string): void {
    const canonical = this.resolve(sessionId);
    const entry = this.sessions.get(canonical);
    this.sessions.delete(canonical);
    // Release any long-lived resources (e.g. a spawned subprocess). No-op for
    // providers whose sessions don't implement dispose().
    entry?.session.dispose?.();
    // Clean up any aliases pointing to this session
    for (const [alias, target] of this.aliases) {
      if (target === canonical) this.aliases.delete(alias);
    }
  }

  /**
   * List all tracked sessions, newest first.
   */
  list(): SessionEntry[] {
    return [...this.sessions.values()].sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt
    );
  }

  /**
   * List sessions forked from a specific parent.
   */
  forksOf(parentSessionId: string): SessionEntry[] {
    return this.list().filter(
      (e) => e.parentSessionId === parentSessionId
    );
  }

  /**
   * Get the number of tracked sessions.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Abort all active sessions and clear tracking.
   */
  disposeAll(): void {
    for (const entry of this.sessions.values()) {
      if (entry.session.isActive) {
        entry.session.abort();
      }
      // Release long-lived resources. No-op for providers without dispose().
      entry.session.dispose?.();
    }
    this.sessions.clear();
    this.aliases.clear();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private evictIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;

    // Find the oldest idle session to evict
    let oldest: { id: string; at: number } | null = null;
    for (const [id, entry] of this.sessions) {
      if (entry.session.isActive) continue; // don't evict active sessions
      if (!oldest || entry.lastActiveAt < oldest.at) {
        oldest = { id, at: entry.lastActiveAt };
      }
    }

    if (oldest) {
      const entry = this.sessions.get(oldest.id);
      this.sessions.delete(oldest.id);
      // Release long-lived resources held by the evicted session. No-op for
      // providers whose sessions don't implement dispose().
      entry?.session.dispose?.();
      // Clean up aliases pointing to the evicted session
      for (const [alias, target] of this.aliases) {
        if (target === oldest.id) this.aliases.delete(alias);
      }
    }
  }
}
