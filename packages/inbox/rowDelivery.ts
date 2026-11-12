import { inboxAgentName, type InboxListRow, type InboxListSection, type InboxRowDelivery } from '@plannotator/core/inbox-types';
import { deliveryText, INBOX_STOPPED_REPLY_TEXT, type DeliveryLine } from './deliveryLine';
import { whenTime } from './format';

export function rowDeliveryName(d: InboxRowDelivery): string {
  const name = inboxAgentName({ kind: 'agent', host: d.host, name: d.name });
  return d.another_session ? `${name} (another session)` : name;
}

export function rowDeliveryLine(d: InboxRowDelivery, time: (iso: string) => string = whenTime): string {
  const name = rowDeliveryName(d);
  const endedName = d.asking ? inboxAgentName({ kind: 'agent', ...d.asking }) : name;
  const text = deliveryText(d.reason, {
    name,
    at: d.at,
    readBy: d.read_by ? inboxAgentName({ kind: 'agent', host: d.read_by, name: null }) : null,
    time,
    undeliveredHost: name,
    endedName,
    wait: rowWait(d) ?? undefined,
    ...(d.state === 'delivered' && d.auto_after_min !== undefined ? { autoAfterMin: d.auto_after_min } : {}),
    ...(d.state === 'delivered' && d.turn_ended ? { turnEnded: true } : {}),
  });
  return d.kind === 'ack' ? `👍 Looks good · ${text}` : text;
}

export function rowWait(d: InboxRowDelivery | null | undefined): NonNullable<DeliveryLine['wait']> | null {
  if (!d || d.reason !== 'working' || !d.waiting_since) return null;
  return { since: d.waiting_since, steerable: d.steerable === true, autoSendAt: d.auto_send_at ?? null };
}

export function rowDeliverySpoken(d: InboxRowDelivery): string {
  const name = rowDeliveryName(d);
  const stopped = d.reason === 'stopped' ? INBOX_STOPPED_REPLY_TEXT.charAt(0).toLowerCase() + INBOX_STOPPED_REPLY_TEXT.slice(1) : null;
  const words =
    stopped ??
    {
      delivered: `delivered to ${name}`,
      undelivered: 'not delivered',
      saved: `saved for ${name}`,
      sending: `sending to ${name}`,
      queued: `queued for ${name}`,
    }[d.state];
  const text = d.kind === 'ack' ? `Looks good, ${words}` : words;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function rowTimeIso(row: InboxListRow): string {
  if (row.snooze_back) return row.last_at;
  return row.delivery?.state === 'delivered' && row.delivery.at ? row.delivery.at : row.last_at;
}

export function deliveriesReadList(change: { labels: boolean; sessions: boolean; agents?: boolean } | undefined, sections: readonly InboxListSection[] | null, agentsShown = false): boolean {
  return !!change?.labels || !!change?.sessions || (!!change?.agents && agentsShown) || hasMovingDelivery(sections);
}

export function hasMovingDelivery(sections: readonly InboxListSection[] | null): boolean {
  const moves = (d: InboxRowDelivery | null | undefined) => !!d && d.state !== 'delivered' && !(d.state === 'saved' && d.reason === 'reads');
  return !!sections?.some((section) => section.threads.some((row) => moves(row.delivery) || row.run !== undefined));
}
