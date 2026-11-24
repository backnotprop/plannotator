import type { MachineView, OutboxView } from '@plannotator/core/inbox-wire-models';
import { InboxApiError, readJson } from './apiError';

/**
 * A write to another machine its Inbox could not confirm yet (linked machines, rule 12): held in this Inbox's
 * outbox (`202`), "Sending…" while that machine is online, "Will send when … is back" while it is not. Never
 * "done": the window waits for the outbox's own frame.
 */
export class InboxHeldError extends InboxApiError {
  constructor(
    readonly outbox: OutboxView,
    readonly machine: MachineView | null,
  ) {
    super(202, 'held', heldWords(machine));
    this.name = 'InboxHeldError';
  }
}

/** What a held write says, by its machine's state. */
export function heldWords(machine: Pick<MachineView, 'name' | 'state'> | null): string {
  const name = machine?.name ?? 'the other machine';
  return machine && machine.state !== 'online' && machine.state !== 'connecting'
    ? `Waiting for ${name}: this applies when ${name} is back.`
    : `Sending to ${name}: this applies once ${name} confirms.`;
}

/** Read a forwarded write that the local Inbox answered from its outbox. */
export async function outboxResult<T>(entry: OutboxView, machine: MachineView | null, diagramPin: boolean): Promise<T> {
  if (entry.state === 'queued' || entry.state === 'sending') throw new InboxHeldError(entry, machine);
  if (entry.state === 'delivered') return entry.answer as T;
  if (diagramPin && entry.state === 'refused' && entry.status === 422) return readJson<T>(Response.json(entry.answer, { status: 422 }));
  const name = machine?.name ?? 'the other machine';
  if (entry.state === 'cancelled') throw new InboxApiError(409, 'outbox_cancelled', `Cancelled. It was never sent to ${name}.`);
  const why = entry.answer && typeof entry.answer === 'object' ? (entry.answer as { error?: unknown }).error : null;
  throw new InboxApiError(409, 'not_delivered', typeof why === 'string' && why ? why : `Not delivered to ${name}.`);
}

type PinWatch = { receive: (entry: OutboxView) => void; read: () => void };
const heldPins = new Set<PinWatch>();

/** The Inbox's stream carries the owner's receipt. A reconnect reads it from this Inbox's disk. */
export function observePinReceipts(entry?: OutboxView): void {
  for (const watch of heldPins) {
    if (entry) watch.receive(entry);
    else watch.read();
  }
}

export function waitForPinReceipt(key: string, read: () => Promise<{ entry: OutboxView }>): Promise<OutboxView> {
  return new Promise((resolve, reject) => {
    const watch: PinWatch = {
      receive(entry) {
        if (entry.key !== key || entry.state === 'queued' || entry.state === 'sending') return;
        heldPins.delete(watch);
        resolve(entry);
      },
      read() {
        void read().then(({ entry }) => watch.receive(entry), cause => {
          // A disconnected window will read again on hello. An expired receipt cannot confirm the pin.
          if (cause instanceof InboxApiError && cause.status === 404) {
            heldPins.delete(watch);
            reject(cause);
          }
        });
      },
    };
    heldPins.add(watch);
    // The receipt frame may have arrived before the original 202 reached the editor.
    watch.read();
  });
}
