import type { SemDiffDownload, SemDiffReply, SemDiffRequest } from './protocol';

export const SPAWN_BACKLOG = 3;

export interface SemDiffWorkerPoolOptions {
  createWorker: () => Worker | Promise<Worker>;
  size: number;
}

interface Slot {
  worker: Promise<Worker>;
  jobs: Set<number>;
  asides: Set<number>;
  downloads: Set<string>;
}

type Message = SemDiffReply | SemDiffDownload;

export function createSemDiffWorkerPool({ createWorker, size }: SemDiffWorkerPoolOptions): Worker {
  const slots: Slot[] = [];
  const waiting: SemDiffRequest[] = [];
  const downloads = new Map<string, number>();
  let warm = false;
  let closed = false;
  const pool = {
    onmessage: null as ((event: MessageEvent<Message>) => void) | null,
    onerror: null as (() => void) | null,
    postMessage,
    terminate,
  };

  const emit = (data: Message) => pool.onmessage?.({ data } as MessageEvent<Message>);

  const release = (slot: Slot, language: string) => {
    if (!slot.downloads.delete(language)) return;
    const left = (downloads.get(language) ?? 1) - 1;
    if (left > 0) downloads.set(language, left);
    else {
      downloads.delete(language);
      emit({ download: 'done', language });
    }
  };

  const heard = (slot: Slot, message: SemDiffDownload) => {
    if (message.download === 'done') return release(slot, message.language);
    if (slot.downloads.has(message.language)) return;
    slot.downloads.add(message.language);
    const count = downloads.get(message.language) ?? 0;
    downloads.set(message.language, count + 1);
    if (count === 0) emit(message);
    dispatch();
  };

  const lost = (slot: Slot) => {
    const at = slots.indexOf(slot);
    if (closed || at < 0) return;
    slots.splice(at, 1);
    void slot.worker.then((w) => w.terminate(), () => {});
    for (const language of [...slot.downloads]) release(slot, language);
    const failed = [...slot.jobs, ...slot.asides];
    slot.jobs.clear();
    slot.asides.clear();
    for (const id of failed) emit({ id, ok: false, error: 'worker stopped' });
    dispatch();
  };

  const spawn = (): Slot => {
    const slot: Slot = { worker: Promise.resolve().then(createWorker), jobs: new Set(), asides: new Set(), downloads: new Set() };
    slots.push(slot);
    slot.worker.then(
      (w) => {
        w.onmessage = (event: MessageEvent<Message>) => {
          if (closed || !slots.includes(slot)) return;
          const data = event.data;
          if ('download' in data) return heard(slot, data);
          if (slot.jobs.delete(data.id)) warm = true;
          else if (!slot.asides.delete(data.id)) return;
          emit(data);
          dispatch();
        };
        w.onerror = () => lost(slot);
      },
      () => lost(slot),
    );
    return slot;
  };

  const send = (slot: Slot, request: SemDiffRequest) => {
    void slot.worker.then((w) => {
      if (!closed && slots.includes(slot)) w.postMessage(request);
    }, () => {});
  };

  const freeSlot = (): Slot | null => {
    const idle = slots.find((slot) => slot.jobs.size === 0);
    if (idle) return idle;
    const stalled = slots.every((slot) => slot.downloads.size > 0);
    if (slots.length === 0 || (warm && slots.length < size && (stalled || waiting.length >= SPAWN_BACKLOG))) return spawn();
    if (!stalled) return null;
    return slots.reduce((least, slot) => (slot.jobs.size < least.jobs.size ? slot : least));
  };

  function dispatch(): void {
    while (!closed && waiting.length > 0) {
      const slot = freeSlot();
      if (!slot) return;
      const visible = waiting.findIndex((request) => !request.background);
      const [request] = waiting.splice(visible < 0 ? 0 : visible, 1);
      slot.jobs.add(request!.id);
      send(slot, request!);
    }
  }

  function postMessage(request: SemDiffRequest): void {
    if (closed) return;
    if (request.opinion) {
      const slot = slots[0] ?? spawn();
      slot.asides.add(request.id);
      send(slot, request);
      return;
    }
    waiting.push(request);
    dispatch();
  }

  function terminate(): void {
    closed = true;
    waiting.length = 0;
    for (const slot of slots.splice(0)) void slot.worker.then((w) => w.terminate(), () => {});
  }

  return pool as unknown as Worker;
}
