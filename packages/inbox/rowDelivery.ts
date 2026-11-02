/**
 * The list row's delivery glyph ("Ticks", approval "inbox-row-delivery",
 * 2026-10-20): its words, from the row's additive `delivery` field, which the
 * server decides with the thread's own rule (`inboxDeliveryState`). The
 * tooltip is the thread's line word for word (`deliveryText`); the row's
 * accessible name carries the state in words. Pure, for the tests.
 */
import { inboxAgentName, type InboxListRow, type InboxListSection, type InboxRowDelivery } from '@plannotator/core/inbox-types';
import { deliveryText, type DeliveryLine } from './deliveryLine';
import { whenTime } from './format';

/** Whom it goes to, as the thread names it ("Claude Code", "Claude Code (another session)", an MCP agent's own name). */
export function rowDeliveryName(d: InboxRowDelivery): string {
  const name = inboxAgentName({ kind: 'agent', host: d.host, name: d.name });
  return d.another_session ? `${name} (another session)` : name;
}

/** The tooltip: the thread's delivery line for the same state (a 👍's says so first). */
export function rowDeliveryLine(d: InboxRowDelivery, time: (iso: string) => string = whenTime): string {
  const name = rowDeliveryName(d);
  // "Saved for <the agent that asked>": the session that asked may be another than the thread's first agent.
  const endedName = d.asking ? inboxAgentName({ kind: 'agent', ...d.asking }) : name;
  const text = deliveryText(d.reason, {
    name,
    at: d.at,
    time,
    undeliveredHost: name,
    endedName,
    wait: rowWait(d) ?? undefined,
    ...(d.state === 'delivered' && d.auto_after_min !== undefined ? { autoAfterMin: d.auto_after_min } : {}),
    ...(d.state === 'delivered' && d.turn_ended ? { turnEnded: true } : {}),
  });
  return d.kind === 'ack' ? `👍 Looks good · ${text}` : text;
}

/**
 * The row's wait on a busy session (approval "inbox-busy-agent-reply"):
 * "Undelivered N min", blue while it can go in now (`steerable`), grey when
 * it cannot. Null for every other state, and from an older Inbox.
 */
export function rowWait(d: InboxRowDelivery | null | undefined): NonNullable<DeliveryLine['wait']> | null {
  if (!d || d.reason !== 'working' || !d.waiting_since) return null;
  return { since: d.waiting_since, steerable: d.steerable === true, autoSendAt: d.auto_send_at ?? null };
}

/** The state in words, for the row's accessible name (the time follows it there). */
export function rowDeliverySpoken(d: InboxRowDelivery): string {
  const name = rowDeliveryName(d);
  const words = {
    delivered: `delivered to ${name}`,
    undelivered: 'not delivered',
    saved: `saved for ${name}`,
    sending: `sending to ${name}`,
    queued: `queued for ${name}`,
  }[d.state];
  const text = d.kind === 'ack' ? `Looks good, ${words}` : words;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The row's time: when it was delivered, once it was; else the thread's latest activity. */
export function rowTimeIso(row: InboxListRow): string {
  // A thread back from a snooze shows its return (a later message, when one came after it).
  if (row.snooze_back) return row.last_at;
  return row.delivery?.state === 'delivered' && row.delivery.at ? row.delivery.at : row.last_at;
}

/**
 * Some row's delivery can still move with the live sessions, so
 * `event: deliveries` reads the list again: anything but delivered, and
 * saved for an agent that only reads the thread (`reads`), which only a store
 * line (its read) changes.
 */
export function hasMovingDelivery(sections: readonly InboxListSection[] | null): boolean {
  const moves = (d: InboxRowDelivery | null | undefined) => !!d && d.state !== 'delivered' && !(d.state === 'saved' && d.reason === 'reads');
  return !!sections?.some((section) => section.threads.some((row) => moves(row.delivery)));
}
