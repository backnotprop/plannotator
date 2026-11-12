import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxAuthor, InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi, resetListReads, type AttachmentsModel, type InboxEvent, type ListModel } from '../../packages/inbox/api';
import { applyListRecord } from '../../packages/inbox/data/apply/list';
import { applyStreamRecord } from '../../packages/inbox/data/apply/stream';
import { createInboxQueryClient } from '../../packages/inbox/data/client';
import { inboxKeys } from '../../packages/inbox/data/keys';
import { sameThreadFiles } from '../../packages/inbox/data/queries/files';
import { heldThread, isThreadStale, putThread } from '../../packages/inbox/data/queries/thread';
import { startInboxServer, type InboxServer } from '../../packages/server/inbox';
import { comparableFiles, heldDrift, listDrift, threadDrift } from './inbox-held-drift';

export const agent = (session: string): Extract<InboxAuthor, { kind: 'agent' }> => ({ kind: 'agent', host: 'claude-code', session, name: null });

export interface ApplyWorld {
  root: string;
  server: InboxServer;
  window: WindowCopy;
  stream: RecordStream;
  projects: { id: string; root: string }[];
  kinds: Map<string, number>;
  stop(): void;
}

class RecordStream {
  seen = 0;
  queue: InboxEvent[] = [];
  private controller = new AbortController();
  private done: Promise<void>;

  constructor(base: string, cursor: number) {
    this.seen = cursor;
    this.done = this.pump(base, cursor).catch(() => {});
  }

  private async pump(base: string, cursor: number): Promise<void> {
    const response = await fetch(`${base}/api/inbox/events?cursor=${cursor}`, { signal: this.controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      text += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = text.indexOf('\n\n')) >= 0) {
        const frame = text.slice(0, end);
        text = text.slice(end + 2);
        if (!/^event: record$/m.test(frame)) continue;
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        const id = Number(/^id: (\d+)$/m.exec(frame)?.[1]);
        if (data) this.queue.push(JSON.parse(data) as InboxEvent);
        if (Number.isFinite(id)) this.seen = Math.max(this.seen, id);
      }
    }
  }

  async through(seq: number): Promise<InboxEvent[]> {
    const deadline = Date.now() + 5000;
    while (this.seen < seq) {
      if (Date.now() > deadline) throw new Error(`the event stream stopped at ${this.seen}, the store is at ${seq}`);
      await Bun.sleep(2);
    }
    return this.queue.splice(0);
  }

  stop(): void {
    this.controller.abort();
    void this.done;
  }
}

const BOARD_OR_SILENT = new Set(['card', 'initiative', 'steps', 'thread_pull']);

export class WindowCopy {
  client = createInboxQueryClient();
  open: string | null = null;
  files: AttachmentsModel | null = null;
  list: ListModel | null = null;
  private filesDue = false;
  private filesThread: InboxThread | null = null;
  private touched = new Set<string>();
  outcomes = new Map<string, number>();

  async openThread(threadId: string): Promise<void> {
    putThread(this.client, threadId, await inboxApi.thread(threadId));
    this.open = threadId;
    await this.readFiles();
  }

  private async readFiles(): Promise<void> {
    this.filesThread = this.open ? (heldThread(this.client, this.open)?.thread ?? null) : null;
    this.files = this.open ? await inboxApi.attachments(this.open) : null;
    this.filesDue = false;
  }

  async readList(): Promise<void> {
    resetListReads();
    this.list = await inboxApi.list();
    this.touched.clear();
  }

  held(): string[] {
    return this.client
      .getQueryCache()
      .findAll({ queryKey: inboxKeys.threads() })
      .map((query) => query.queryKey[2])
      .filter((id): id is string => typeof id === 'string');
  }

  take(event: InboxEvent): void {
    if (BOARD_OR_SILENT.has(event.kind)) {
      this.count(`${event.kind}:not-applied`);
      return;
    }
    const outcome = applyStreamRecord(this.client, event);
    this.count(`${event.kind}:${outcome.kind}`);
    if (this.open && outcome.threadId === this.open && outcome.kind !== 'any' && outcome.files) this.filesDue = true;
    if (this.list) {
      const next = applyListRecord(this.list, event);
      if (next) {
        this.list = next;
        if (event.kind === 'message') this.touched.add(event.message.thread_id);
      }
    }
  }

  private count(key: string): void {
    this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);
  }

  async settle(): Promise<void> {
    if (!this.open) return;
    if (isThreadStale(this.client, this.open)) {
      putThread(this.client, this.open, await inboxApi.thread(this.open));
      this.filesDue = true;
    }
    const now = heldThread(this.client, this.open)?.thread;
    if (this.filesDue || !this.filesThread || !now || !sameThreadFiles(this.filesThread, now)) await this.readFiles();
  }

  async drift(): Promise<string | null> {
    const out: string[] = [];
    for (const threadId of this.held()) {
      if (isThreadStale(this.client, threadId)) continue;
      const held = heldThread(this.client, threadId)!;
      const drift = threadDrift(held, await inboxApi.thread(threadId));
      if (drift) out.push(`thread ${threadId}${threadId === this.open ? ' (open)' : ''}:\n${drift}`);
    }
    if (this.open && this.files) {
      const drift = heldDrift(comparableFiles(this.files), comparableFiles(await inboxApi.attachments(this.open)));
      if (drift) out.push(`files of ${this.open}:\n${drift}`);
    }
    if (this.list && this.touched.size > 0) {
      resetListReads();
      const drift = listDrift(this.list, await inboxApi.list(), this.touched);
      if (drift) out.push(`list rows ${[...this.touched].join(', ')}:\n${drift}`);
    }
    return out.length > 0 ? out.join('\n') : null;
  }
}

export async function startApplyWorld(): Promise<ApplyWorld> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-apply-diff-')));
  for (const folder of ['web', 'api', 'elsewhere/web']) mkdirSync(join(root, folder), { recursive: true });
  const dataDir = join(root, 'data');
  const previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 60_000, threadPullFixture: () => ({}) });
  const base = `http://127.0.0.1:${server.port}`;
  const projects = ['web', 'api'].map((name) => ({ id: server.store.ensureProject({ name, root: join(root, name) }).id, root: join(root, name) }));
  const window = new WindowCopy();
  const stream = new RecordStream(base, server.store.cursor());
  return {
    root,
    server,
    window,
    stream,
    projects,
    kinds: new Map(),
    stop() {
      stream.stop();
      server.stop();
      if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
