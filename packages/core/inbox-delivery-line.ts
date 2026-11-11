import {
  inboxAutoSendInMinutes,
  inboxDeliveryState,
  wholeMinutes,
  type InboxDeliverNowBy,
  inboxEngineTooOldForSendNow,
  inboxLoadedPredatesSendNow,
  type InboxDeliveryReason,
  type InboxDeliveryState,
  type InboxReloadRuntime,
  type InboxSessionOutdated,
} from './inbox-types';

/** How the session the message goes to is connected now (the sessions route's `asker.connection`). */
export interface RecipientConnection {
  busy: boolean | null;
  idle_since: string | null;
  send_now: boolean;
  outdated?: InboxSessionOutdated | null;
  held?: boolean;
  engine?: string | null;
  restart_command?: string | null;
  auto_send_after_ms?: number;
  waits?: Record<string, { since: string; auto_since: string | null }>;
  uncertain?: string[];
}

/** Whether an item may not have reached the session it was handed to (`connection.uncertain`). */
export function uncertainItem(connection: RecipientConnection | null | undefined, itemId: string): boolean {
  return connection?.uncertain?.includes(itemId) === true;
}

/** The wait inputs of `deliveryLine` for one item: the server's clock while it waits, its own record after the mark. */
export function waitInputs(
  connection: RecipientConnection | null | undefined,
  itemId: string,
  item: { wait_started_at?: string | null; deliver_now_by?: InboxDeliverNowBy | null; deliver_now_at?: string | null; into_turn?: boolean | null },
): Pick<DeliveryLineInput, 'waitingSince' | 'autoSince' | 'nowBy' | 'nowAt' | 'intoTurn'> {
  const clock = connection?.waits?.[itemId];
  return {
    waitingSince: clock?.since ?? item.wait_started_at ?? null,
    autoSince: clock?.auto_since ?? null,
    nowBy: item.deliver_now_by ?? null,
    nowAt: item.deliver_now_at ?? null,
    intoTurn: item.into_turn ?? null,
  };
}

export interface RestartNote {
  fix: InboxSessionOutdated['fix'];
  command: string | null;
  updateCommand: string | null;
  runtime: InboxReloadRuntime;
  reloadCommand: string;
  reloadWhere: 'session' | 'shell';
  fallbackCommand: string | null;
  pinnedSpec: string | null;
  pinTo: string | null;
  updatesAll: boolean;
}

/** Claude Code's reload (the mod reloads with the plugins). */
export const CLAUDE_RELOAD_COMMAND = '/reload-plugins';

/**
 * The restart note for a session that works now and has no Send now because it runs an older
 * plugin.
 */
export function restartNote(connection: RecipientConnection | null | undefined): RestartNote | null {
  const outdated = connection?.outdated;
  if (!connection || !outdated || connection.busy !== true || connection.send_now) return null;
  if (inboxEngineTooOldForSendNow(connection.engine)) return null;
  if (!inboxLoadedPredatesSendNow(outdated.loaded)) return null;
  const command = connection.restart_command ?? null;
  const runtime = outdated.runtime ?? 'claude-code';
  const reload = {
    runtime,
    reloadCommand: outdated.reload_command ?? CLAUDE_RELOAD_COMMAND,
    reloadWhere: outdated.reload_where ?? 'session',
    fallbackCommand: outdated.fallback_command ?? null,
    pinnedSpec: outdated.pinned_spec ?? null,
    pinTo: outdated.pin_to ?? null,
    updatesAll: outdated.update_scope === 'all',
  } as const;
  if (runtime === 'claude-code') {
    if (outdated.fix === 'update_plugin') return { fix: outdated.fix, command, updateCommand: outdated.update_command ?? null, ...reload };
    if (outdated.fix !== 'restart') return null;
    return { fix: outdated.fix, command, updateCommand: null, ...reload };
  }
  if (outdated.fix === 'reload') return { fix: outdated.fix, command: null, updateCommand: null, ...reload };
  if (outdated.fix === 'update_extension' && (outdated.update_command || outdated.pinned_spec)) {
    return { fix: outdated.fix, command: null, updateCommand: outdated.update_command ?? null, ...reload };
  }
  return null;
}

export type DeliveryLineState = InboxDeliveryState;

export interface DeliveryLine {
  state: DeliveryLineState;
  text: string;
  ended?: boolean;
  /** Its session's connection took it and stopped while delivering it: that session never gets it, so it may move. */
  stuck?: boolean;
  sendNow?: boolean;
  wait?: { since: string; steerable: boolean; autoSendAt: string | null };
  autoAfterMin?: number;
  turnEnded?: boolean;
}

/** The parts of the "Undelivered" band at `now`: "Undelivered 3 min", and what happens next. */
export interface UndeliveredWords {
  label: string;
  next: string;
  auto: boolean;
}

function undeliveredAge(since: string, now: number): { short: string; long: string } | null {
  const minutes = wholeMinutes(since, now);
  if (minutes < 1) return null;
  if (minutes < 60) return { short: `${minutes}m`, long: `${minutes} min` };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { short: `${hours}h`, long: `${hours} hour${hours === 1 ? '' : 's'}` };
  const days = Math.floor(hours / 24);
  return { short: `${days}d`, long: `${days} day${days === 1 ? '' : 's'}` };
}

/** "Undelivered 3 min", "Undelivered 2 hours", "Undelivered 1 day" ("Undelivered" under a minute). */
export function undeliveredLabel(since: string, now: number): string {
  const age = undeliveredAge(since, now);
  return age ? `Undelivered ${age.long}` : 'Undelivered';
}

/** The list row's short form (approval "inbox-row-byline", option A): "Undelivered 3m", "Undelivered 2h", "Undelivered 1d". */
export function undeliveredShort(since: string, now: number): string {
  const age = undeliveredAge(since, now);
  return age ? `Undelivered ${age.short}` : 'Undelivered';
}

export function undeliveredWords(wait: NonNullable<DeliveryLine['wait']>, now: number): UndeliveredWords {
  const label = undeliveredLabel(wait.since, now);
  if (wait.autoSendAt) {
    const left = inboxAutoSendInMinutes(wait.autoSendAt, now);
    const next = left === null ? 'goes in by itself now' : left === 0 ? 'goes in by itself in under a minute' : `goes in by itself in ${left} min`;
    return { label, next, auto: true };
  }
  return { label, next: 'it gets this when its turn ends', auto: false };
}

export interface DeliveryLineInput {
  name: string;
  deliveredAt: string | null;
  time: (iso: string) => string;
  wakes: boolean;
  sendingNow: boolean;
  connection: RecipientConnection | null | undefined;
  askerEnded?: { name: string } | null;
  readBy?: string | null;
  undelivered?: { host: string } | null;
  stuck?: boolean;
  waitingSince?: string | null;
  autoSince?: string | null;
  intoTurn?: boolean | null;
  /** Override the connection's wait before it goes in by itself (null: never, e.g. a 👍 note while they wait for the turn). */
  autoSendAfterMs?: number | null;
  nowBy?: InboxDeliverNowBy | null;
  nowAt?: string | null;
  now?: number;
}

export function deliveryLine(input: DeliveryLineInput): DeliveryLine {
  const { name } = input;
  const decision = inboxDeliveryState({
    delivered: !!input.deliveredAt,
    undelivered: !!input.undelivered,
    stuck: !!input.stuck,
    askerEnded: !!input.askerEnded,
    wakes: input.wakes,
    sendingNow: input.sendingNow,
    connection: input.connection,
    waitingSince: input.waitingSince ?? null,
    autoSince: input.autoSince ?? null,
    intoTurn: input.intoTurn ?? null,
    nowBy: input.nowBy ?? null,
    nowAt: input.nowAt ?? null,
    autoSendAfterMs: input.autoSendAfterMs !== undefined ? input.autoSendAfterMs : (input.connection?.auto_send_after_ms ?? null),
  });
  const text = deliveryText(decision.reason, {
    name,
    at: input.deliveredAt,
    readBy: input.readBy,
    time: input.time,
    undeliveredHost: input.undelivered?.host ?? name,
    endedName: input.askerEnded?.name ?? name,
    wait: decision.wait,
    autoAfterMin: decision.autoAfterMin,
    turnEnded: decision.turnEnded,
    now: input.now,
  });
  return {
    state: decision.state,
    text,
    ...(decision.reason === 'ended' ? { ended: true } : {}),
    ...(decision.reason === 'stuck' ? { stuck: true } : {}),
    ...(decision.reason === 'working' ? { sendNow: decision.sendNow } : {}),
    ...(decision.wait ? { wait: decision.wait } : {}),
    ...(decision.autoAfterMin !== undefined && decision.reason === 'delivered' ? { autoAfterMin: decision.autoAfterMin } : {}),
    ...(decision.turnEnded ? { turnEnded: true } : {}),
  };
}

/** The words for each case of the rule: the thread's line, and the list row's tooltip. */
export function deliveryText(
  reason: InboxDeliveryReason,
  words: {
    name: string;
    at: string | null;
    time: (iso: string) => string;
    undeliveredHost: string;
    readBy?: string | null;
    endedName: string;
    wait?: DeliveryLine['wait'];
    autoAfterMin?: number;
    turnEnded?: boolean;
    now?: number;
  },
): string {
  const { name } = words;
  switch (reason) {
    case 'delivered': {
      if (words.readBy && words.at) return `Read by ${words.readBy}, ${words.time(words.at)}`;
      const base = words.at ? `Delivered to ${name}, ${words.time(words.at)}` : `Delivered to ${name}`;
      if (words.autoAfterMin !== undefined) return `${base} · ${autoAfterText(words.autoAfterMin)}`;
      return words.turnEnded ? `${base} · ${TURN_ENDED_TEXT}` : base;
    }
    case 'undelivered':
      return `Not delivered. That ${words.undeliveredHost} session stopped before it took this. If it is resumed, it still gets it.`;
    case 'stuck':
      return `Not delivered. ${name} stopped while it was taking this, so it may not have it.`;
    case 'ended':
      return `Saved for ${words.endedName}. That session has ended; it gets this only if it's resumed.`;
    case 'reads':
      return `Saved for ${name}. It sees it when it next reads this thread.`;
    case 'sending_now':
      return `Sending to ${name} now…`;
    case 'working': {
      if (!words.wait) return `Queued · ${name} is working; it gets this when its turn ends.`;
      const parts = undeliveredWords(words.wait, words.now ?? Date.now());
      return `${parts.label} · ${name} is working · ${parts.next}`;
    }
    case 'idle':
      return `Sending to ${name}…`;
    case 'away':
      return `Queued for ${name}; it gets this when its session is back.`;
    case 'next_turn':
      return `Queued for ${name}; it gets this as its next turn.`;
    case 'ack_pending':
      return `Goes to ${name} in a few seconds`;
    case 'stopped':
      return INBOX_STOPPED_REPLY_TEXT;
  }
}

/** The Sent row's line in the list, which knows no connection: queued for a waking agent, saved otherwise. */
export function sentRowLine(name: string, wakes: boolean | undefined): string {
  return wakes === true ? `Queued for ${name}; it gets this as its next turn.` : `Saved for ${name}. It sees it when it next reads this thread.`;
}

/**
 * A Sent row whose last message is the person's Re-ask note (approval "inbox-reask"): it stays Sent
 * until the agent asks again, read or not.
 */
export function reaskRowLine(name: string, checkedAt: string | null, wakes: boolean | undefined): string {
  if (checkedAt) return `Asked ${name} to re-ask; waiting for its message.`;
  return wakes === true ? `Re-ask queued for ${name}; it gets this as its next turn.` : `Re-ask saved for ${name}. It sees it when it next reads this thread.`;
}

export const INBOX_STOPPED_REPLY_TEXT = 'Stopped: goes in when you type in that session';

/** An item the Inbox marked to go in by itself that waited for the turn to end (its own Ask question held it). */
export const TURN_ENDED_TEXT = 'went in when its turn ended';

/** "went into its turn by itself after 5 min". */
export function autoAfterText(minutes: number): string {
  return `went into its turn by itself after ${minutes} min`;
}
