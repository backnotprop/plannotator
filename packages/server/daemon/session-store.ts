import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type {
  DaemonRemoteShareNotice,
  DaemonSessionEvent,
  DaemonSessionMode,
  DaemonSessionStatus,
  DaemonSessionSummary,
} from "@plannotator/shared/daemon-protocol";
import type { SessionRequestHandler } from "../session-handler";

export interface DaemonSessionRecord<TResult = unknown> {
  id: string;
  mode: DaemonSessionMode;
  status: DaemonSessionStatus;
  url: string;
  project: string;
  cwd?: string;
  label: string;
  origin?: string;
  matchKey?: string;
  ttlMs?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  result?: TResult;
  error?: string;
  remoteShare?: DaemonRemoteShareNotice;
  htmlContent?: string;
  handleRequest?: SessionRequestHandler;
  dispose?: () => void | Promise<void>;
  disposed?: boolean;
  snapshot?: () => unknown;
}

export interface CreateDaemonSessionInput<TResult = unknown> {
  id?: string;
  mode: DaemonSessionMode;
  url: string;
  project: string;
  cwd?: string;
  label: string;
  origin?: string;
  matchKey?: string;
  ttlMs?: number;
  now?: number;
  htmlContent?: string;
  handleRequest?: SessionRequestHandler;
  dispose?: () => void | Promise<void>;
  result?: TResult;
  remoteShare?: DaemonRemoteShareNotice;
  snapshot?: () => unknown;
}

export interface SessionSnapshot {
  version: 1;
  mode: DaemonSessionMode;
  sessionId: string;
  status: string;
  result: unknown;
  capturedAt: string;
  meta: { project: string; origin?: string; cwd?: string; label: string };
  content: unknown;
}

const SNAPSHOT_DIR = join(homedir(), ".plannotator", "sessions");
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

function writeSnapshot(record: DaemonSessionRecord): void {
  if (!record.snapshot) return;
  try {
    const content = record.snapshot();
    const snapshot: SessionSnapshot = {
      version: 1,
      mode: record.mode,
      sessionId: record.id,
      status: record.status,
      result: record.result,
      capturedAt: new Date().toISOString(),
      meta: { project: record.project, origin: record.origin, cwd: record.cwd, label: record.label },
      content,
    };
    const json = JSON.stringify(snapshot);
    if (json.length > MAX_SNAPSHOT_BYTES) return;
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(join(SNAPSHOT_DIR, `${record.id}.json`), json, "utf-8");
  } catch {}
}

export function readSnapshot(sessionId: string): SessionSnapshot | null {
  try {
    const raw = readFileSync(join(SNAPSHOT_DIR, `${sessionId}.json`), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && parsed?.sessionId === sessionId) return parsed as SessionSnapshot;
  } catch {}
  return null;
}

export function listSnapshots(): SessionSnapshot[] {
  try {
    const files = readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json"));
    const snapshots: SessionSnapshot[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(SNAPSHOT_DIR, file), "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed?.version === 1) snapshots.push(parsed as SessionSnapshot);
      } catch {}
    }
    return snapshots;
  } catch {
    return [];
  }
}

export interface DaemonSessionStoreOptions {
  idFactory?: () => string;
  now?: () => number;
}

type Waiter<TResult> = {
  resolve: (record: DaemonSessionRecord<TResult>) => void;
  reject: (err: Error) => void;
};

export type DaemonSessionStoreListener = (event: DaemonSessionEvent) => void;

const TERMINAL_STATUSES = new Set<DaemonSessionStatus>([
  "completed",
  "cancelled",
  "expired",
  "failed",
]);
const TERMINAL_SESSION_TTL_MS = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function createDaemonSessionId(): string {
  return `sess_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export class DaemonSessionStore {
  private sessions = new Map<string, DaemonSessionRecord>();
  private waiters = new Map<string, Waiter<unknown>[]>();
  private listeners = new Set<DaemonSessionStoreListener>();
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(options: DaemonSessionStoreOptions = {}) {
    this.idFactory = options.idFactory ?? createDaemonSessionId;
    this.now = options.now ?? (() => Date.now());
  }

  onMutation(listener: DaemonSessionStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  create<TResult = unknown>(input: CreateDaemonSessionInput<TResult>): DaemonSessionRecord<TResult> {
    const now = input.now ?? this.now();
    const id = input.id ?? this.idFactory();
    const record: DaemonSessionRecord<TResult> = {
      id,
      mode: input.mode,
      status: input.result === undefined ? "active" : "completed",
      url: input.url,
      project: input.project,
      label: input.label,
      ...(input.cwd && { cwd: input.cwd }),
      ...(input.origin && { origin: input.origin }),
      ...(input.matchKey && { matchKey: input.matchKey }),
      ...(input.ttlMs !== undefined && { ttlMs: input.ttlMs }),
      createdAt: iso(now),
      updatedAt: iso(now),
      ...(input.ttlMs !== undefined && { expiresAt: iso(now + input.ttlMs) }),
      ...(input.htmlContent && { htmlContent: input.htmlContent }),
      ...(input.handleRequest && { handleRequest: input.handleRequest }),
      ...(input.dispose && { dispose: input.dispose }),
      ...(input.result !== undefined && { result: input.result }),
      ...(input.remoteShare && { remoteShare: input.remoteShare }),
    };
    this.sessions.set(id, record);
    this.emit("session-created", record);
    if (TERMINAL_STATUSES.has(record.status)) this.resolveWaiters(record);
    return record;
  }

  get<TResult = unknown>(id: string): DaemonSessionRecord<TResult> | undefined {
    return this.sessions.get(id) as DaemonSessionRecord<TResult> | undefined;
  }

  list(): DaemonSessionSummary[] {
    return [...this.sessions.values()]
      .filter((record) => !TERMINAL_STATUSES.has(record.status))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .map((record) => this.summary(record));
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((record) => !TERMINAL_STATUSES.has(record.status)).length;
  }

  totalCount(): number {
    return this.sessions.size;
  }

  summary(record: DaemonSessionRecord, options: { includeRemoteShare?: boolean } = {}): DaemonSessionSummary {
    return {
      id: record.id,
      mode: record.mode,
      status: record.status,
      url: record.url,
      project: record.project,
      ...(record.cwd && { cwd: record.cwd }),
      label: record.label,
      ...(record.origin && { origin: record.origin }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.expiresAt && { expiresAt: record.expiresAt }),
      ...(record.error && { error: record.error }),
      ...(options.includeRemoteShare && record.remoteShare && { remoteShare: record.remoteShare }),
    };
  }

  complete<TResult = unknown>(id: string, result: TResult): DaemonSessionRecord<TResult> | undefined {
    const record = this.sessions.get(id) as DaemonSessionRecord<TResult> | undefined;
    if (!record || TERMINAL_STATUSES.has(record.status)) return record;
    record.status = "completed";
    record.result = result;
    const now = this.now();
    record.updatedAt = iso(now);
    record.expiresAt = iso(now + TERMINAL_SESSION_TTL_MS);
    this.resolveWaiters(record);
    this.emit("session-updated", record);
    writeSnapshot(record);
    void this.disposeResources(record);
    this.releaseRoutingPayloads(record);
    return record;
  }

  fail(id: string, error: string): DaemonSessionRecord | undefined {
    const record = this.sessions.get(id);
    if (!record || TERMINAL_STATUSES.has(record.status)) return record;
    record.status = "failed";
    record.error = error;
    const now = this.now();
    record.updatedAt = iso(now);
    record.expiresAt = iso(now + TERMINAL_SESSION_TTL_MS);
    this.resolveWaiters(record);
    this.emit("session-updated", record);
    void this.disposeResources(record);
    this.releaseRoutingPayloads(record);
    return record;
  }

  suspend<TResult = unknown>(id: string, result: TResult): DaemonSessionRecord<TResult> | undefined {
    const record = this.sessions.get(id) as DaemonSessionRecord<TResult> | undefined;
    if (!record || record.status !== "active") return record;
    record.status = "awaiting-resubmission";
    record.result = result;
    const now = this.now();
    record.updatedAt = iso(now);
    delete record.expiresAt;
    this.resolveWaiters(record);
    this.emit("session-updated", record);
    return record;
  }

  idle<TResult = unknown>(id: string, result?: TResult): DaemonSessionRecord<TResult> | undefined {
    const record = this.sessions.get(id) as DaemonSessionRecord<TResult> | undefined;
    if (!record || TERMINAL_STATUSES.has(record.status) || record.status === "idle") return undefined;
    record.status = "idle";
    if (result !== undefined) record.result = result as TResult;
    const now = this.now();
    record.updatedAt = iso(now);
    delete record.expiresAt;
    this.resolveWaiters(record);
    this.emit("session-updated", record);
    return record;
  }

  reactivate(id: string): DaemonSessionRecord | undefined {
    const record = this.sessions.get(id);
    if (!record || (record.status !== "awaiting-resubmission" && record.status !== "idle")) return record;
    record.status = "active";
    record.result = undefined;
    const now = this.now();
    record.updatedAt = iso(now);
    delete record.expiresAt;
    this.emit("session-updated", record);
    return record;
  }

  async cancel(id: string, reason = "Session cancelled."): Promise<DaemonSessionRecord | undefined> {
    const record = this.sessions.get(id);
    if (!record || TERMINAL_STATUSES.has(record.status)) return record;
    record.status = "cancelled";
    record.error = reason;
    const now = this.now();
    record.updatedAt = iso(now);
    record.expiresAt = iso(now + TERMINAL_SESSION_TTL_MS);
    this.resolveWaiters(record);
    this.emit("session-updated", record);
    await this.disposeRecord(record);
    return record;
  }

  waitForResult<TResult = unknown>(id: string): Promise<DaemonSessionRecord<TResult>> {
    const record = this.sessions.get(id) as DaemonSessionRecord<TResult> | undefined;
    if (!record) return Promise.reject(new Error(`Session not found: ${id}`));
    const hasIntermediateResult = (record.status === "idle" || record.status === "awaiting-resubmission") && record.result !== undefined;
    if (TERMINAL_STATUSES.has(record.status) || hasIntermediateResult) return Promise.resolve(record);
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(id) ?? [];
      waiters.push({ resolve: resolve as (record: DaemonSessionRecord<unknown>) => void, reject });
      this.waiters.set(id, waiters);
    });
  }

  async delete(id: string): Promise<boolean> {
    const record = this.sessions.get(id);
    if (!record) return false;
    this.sessions.delete(id);
    this.rejectWaiters(id, new Error(`Session deleted: ${id}`));
    await this.disposeRecord(record);
    this.emit("session-removed", record);
    return true;
  }

  async cleanupExpired(now = this.now()): Promise<DaemonSessionRecord[]> {
    const expired: DaemonSessionRecord[] = [];
    for (const record of [...this.sessions.values()]) {
      if (!record.expiresAt) continue;
      if (new Date(record.expiresAt).getTime() > now) continue;
      if (TERMINAL_STATUSES.has(record.status)) {
        expired.push(record);
        await this.removeRecord(record);
        continue;
      }
      record.status = "expired";
      record.error = "Session expired.";
      record.updatedAt = iso(now);
      expired.push(record);
      this.resolveWaiters(record);
      this.emit("session-updated", record);
      await this.removeRecord(record);
    }
    return expired;
  }

  async cancelAll(reason = "Daemon shutting down."): Promise<void> {
    const records = [...this.sessions.values()];
    for (const record of records) {
      if (!TERMINAL_STATUSES.has(record.status)) {
        record.status = "cancelled";
        record.error = reason;
        const now = this.now();
        record.updatedAt = iso(now);
        record.expiresAt = iso(now + TERMINAL_SESSION_TTL_MS);
        this.resolveWaiters(record);
        this.emit("session-updated", record);
      }
      await this.disposeRecord(record);
    }
  }

  private emit(type: DaemonSessionEvent["type"], record: DaemonSessionRecord): void {
    if (this.listeners.size === 0) return;
    const event: DaemonSessionEvent = {
      type,
      at: iso(this.now()),
      session: this.summary(record, { includeRemoteShare: true }),
    };
    for (const listener of this.listeners) listener(event);
  }

  private resolveWaiters(record: DaemonSessionRecord): void {
    const waiters = this.waiters.get(record.id) ?? [];
    this.waiters.delete(record.id);
    for (const waiter of waiters) waiter.resolve(record);
  }

  private rejectWaiters(id: string, err: Error): void {
    const waiters = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const waiter of waiters) waiter.reject(err);
  }

  private async removeRecord(record: DaemonSessionRecord): Promise<void> {
    this.sessions.delete(record.id);
    await this.disposeRecord(record);
    this.emit("session-removed", record);
  }

  private async disposeRecord(record: DaemonSessionRecord): Promise<void> {
    await this.disposeResources(record);
    this.releaseRoutingPayloads(record);
  }

  private async disposeResources(record: DaemonSessionRecord): Promise<void> {
    if (record.disposed) return;
    record.disposed = true;
    const dispose = record.dispose;
    record.dispose = undefined;
    try {
      await dispose?.();
    } catch {
      // Best-effort cleanup; callers observe session status separately.
    }
  }

  private releaseRoutingPayloads(record: DaemonSessionRecord): void {
    record.htmlContent = undefined;
    record.handleRequest = undefined;
  }
}
