/**
 * The line under the person's last reply or message: where it is now.
 *
 * The owner's request (2026-10-16): "The message should be less deceiving.
 * It should say this message is queued up or something. And then maybe an
 * option just to send it immediately." A reply to a session whose connection
 * wakes it (the Claude Code mod, Pi, OpenCode 2) is delivered as a turn by
 * itself once the session is idle, so the line says what it waits for, from
 * what the Inbox knows about that session's connection right now (its poll's
 * `busy`), and offers Send now while the session works and its connection
 * can put the reply into the running turn (`send_now`). A reply to an agent
 * that only reads the thread (MCP, OpenCode 1) keeps the truthful "it sees
 * it when it next reads this thread". Pure: Thread.tsx draws it.
 */

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
  /** It runs an older Plannotator plugin than a restart loads (packages/server/inbox-restart.ts). Absent from an older Inbox. */
  outdated?: InboxSessionOutdated | null;
  /** Claude Code's version as its poll said (absent or null: unknown). */
  engine?: string | null;
  /** `cd <folder> && claude --resume <id>`, when the Inbox knows the folder. Absent from an older Inbox. */
  restart_command?: string | null;
  /** How long a reply waits on this busy session before it goes in by itself. Absent from an older Inbox (never). */
  auto_send_after_ms?: number;
  /**
   * The server's clocks for the items waiting on this session, by id: since
   * when each waits on the busy session, and since when it may go in by
   * itself (null: not yet). Absent from an older Inbox.
   */
  waits?: Record<string, { since: string; auto_since: string | null }>;
  /**
   * Items that may not have reached this session (a Codex thread whose
   * `codex queue` call ran out of time): their line says saved, not queued.
   * Absent from an older Inbox and when none.
   */
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

/**
 * Why Send now is not offered for a busy session, and what brings it back
 * (owner approval "restart-warning", 2026-10-19, the "Steps" line): the
 * session runs an older plugin than a restart loads (`restart`), or the
 * installed plugin is itself behind this Inbox (`update_plugin`).
 */
export interface RestartNote {
  fix: InboxSessionOutdated['fix'];
  /** The command that brings the session back as itself (Claude Code); null when the Inbox does not know its folder. */
  command: string | null;
  /** The plugin update command (`update_plugin`, `update_extension`). */
  updateCommand: string | null;
  /**
   * The runtime and its reload (owner approval "reload-hosts"): Claude Code
   * `/reload-plugins`, Pi `/reload`, Oh My Pi `/restart` (typed in the
   * session), OpenCode 2 `opencode2 reload` or `opencode2 plugin update` (run
   * in a shell), with OpenCode's fallback `opencode2 service restart`.
   */
  runtime: InboxReloadRuntime;
  reloadCommand: string;
  reloadWhere: 'session' | 'shell';
  fallbackCommand: string | null;
  /** OpenCode 2: the config pins this exact spec; it changes to `pinTo`, then `opencode2 reload`. */
  pinnedSpec: string | null;
  pinTo: string | null;
  /** OpenCode 2's `opencode2 plugin update` with no target: it updates every outdated plugin. */
  updatesAll: boolean;
}

/** Claude Code's reload (the mod reloads with the plugins). */
export const CLAUDE_RELOAD_COMMAND = '/reload-plugins';

/**
 * The restart note for a session that works now and has no Send now
 * because it runs an older plugin. Only then: an idle session gets the reply
 * at once anyway, and a session with Send now is not missing anything. An
 * engine too old for Send now stays quiet (a restart would not bring it; the
 * owner chose to say nothing about that, 2026-10-19).
 */
export function restartNote(connection: RecipientConnection | null | undefined): RestartNote | null {
  const outdated = connection?.outdated;
  if (!connection || !outdated || connection.busy !== true || connection.send_now) return null;
  if (inboxEngineTooOldForSendNow(connection.engine)) return null;
  // A session that loaded a plugin with Send now lacks it for another reason (its own Ask question holds the
  // turn, the engine refused a row): a restart would not change that, so the line never blames the plugin.
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
  // Pi, Oh My Pi, OpenCode 2: a reload alone, or the update first.
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
  /** The asking session ended: a clock, not a check. */
  ended?: boolean;
  /** Offer Send now: the session works and its connection can take the reply mid-turn. */
  sendNow?: boolean;
  /**
   * It waits on a busy session (approval "inbox-busy-agent-reply"): since
   * when, whether it can go in now (`steerable`), and when it goes in by
   * itself (null: it will not). The band under the reply draws it with its
   * own minute clock (`undeliveredWords`).
   */
  wait?: { since: string; steerable: boolean; autoSendAt: string | null };
  /** It went into the turn by itself after this many minutes ("went into its turn by itself after 5 min"). */
  autoAfterMin?: number;
  /** Marked to go in by itself, but it went in when the turn ended (the session's own Ask question held it). */
  turnEnded?: boolean;
}

/** The parts of the "Undelivered" band at `now`: "Undelivered 3 min", and what happens next. */
export interface UndeliveredWords {
  /** "Undelivered 3 min" (whole minutes, then hours, then days; "Undelivered" under a minute). */
  label: string;
  /** "goes in by itself in 2 min" / "in under a minute", or "it gets this when its turn ends". */
  next: string;
  /** It goes in by itself (the countdown shows). */
  auto: boolean;
}

/**
 * How long a reply has waited, in the Inbox's age units (a board card's "5m", "3h", "2d"): whole minutes under an
 * hour, whole hours under a day, then whole days; never seconds. Null under a minute.
 */
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
  /** "Claude Code", "Pi (another session)". */
  name: string;
  /** Delivered (or read by the agent) at; null while it waits. */
  deliveredAt: string | null;
  /** Formats a time for the line ("5:12 PM"). */
  time: (iso: string) => string;
  /** The session it goes to is woken by its connection (a waking agent message, or a message addressed to a live session). */
  wakes: boolean;
  /** The person pressed Send now (`deliver_now_at`). */
  sendingNow: boolean;
  /**
   * That session's connection as the Inbox knows it now: undefined while not
   * read yet or from an older Inbox (no `connection`), null when it does not
   * poll now.
   */
  connection: RecipientConnection | null | undefined;
  /** The asking session ended (a reply), with the asker's name for the line. */
  askerEnded?: { name: string } | null;
  /** A message addressed to a session that stopped before it took it (compose). */
  undelivered?: { host: string } | null;
  /** When it began to wait on the busy session (the server's clock): the line says how long. */
  waitingSince?: string | null;
  /** When the clock toward going in by itself started (the server's); null: it does not go in by itself yet. */
  autoSince?: string | null;
  /** Delivered after the Inbox's own mark: whether it went into the running turn (`delivery.into_turn`). */
  intoTurn?: boolean | null;
  /** Override the connection's wait before it goes in by itself (null: never, e.g. a 👍 note while they wait for the turn). */
  autoSendAfterMs?: number | null;
  /** Who asked for it to go now (`deliver_now_by`), and when (`deliver_now_at`). */
  nowBy?: InboxDeliverNowBy | null;
  nowAt?: string | null;
  /** `now`: the clock the words are written at (default `Date.now()`). */
  now?: number;
}

export function deliveryLine(input: DeliveryLineInput): DeliveryLine {
  const { name } = input;
  // The state is the shared rule's (packages/core/inbox-delivery.ts, through @plannotator/core/inbox-types), which also decides the list row's glyph.
  const decision = inboxDeliveryState({
    delivered: !!input.deliveredAt,
    undelivered: !!input.undelivered,
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
    endedName: string;
    /** It waits on a busy session (approval "inbox-busy-agent-reply"): "Undelivered 3 min · …". */
    wait?: DeliveryLine['wait'];
    /** It went into the turn by itself after this many minutes. */
    autoAfterMin?: number;
    /** Marked to go in by itself, it went in when the turn ended instead. */
    turnEnded?: boolean;
    now?: number;
  },
): string {
  const { name } = words;
  switch (reason) {
    case 'delivered': {
      const base = words.at ? `Delivered to ${name}, ${words.time(words.at)}` : `Delivered to ${name}`;
      if (words.autoAfterMin !== undefined) return `${base} · ${autoAfterText(words.autoAfterMin)}`;
      return words.turnEnded ? `${base} · ${TURN_ENDED_TEXT}` : base;
    }
    case 'undelivered':
      return `Not delivered. That ${words.undeliveredHost} session stopped before it took this. If it is resumed, it still gets it.`;
    case 'ended':
      return `Saved for ${words.endedName}. The session that asked has ended, so it waits here until an agent reads this thread.`;
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
  }
}

/** The Sent row's line in the list, which knows no connection: queued for a waking agent, saved otherwise. */
export function sentRowLine(name: string, wakes: boolean | undefined): string {
  return wakes === true ? `Queued for ${name}; it gets this as its next turn.` : `Saved for ${name}. It sees it when it next reads this thread.`;
}

/**
 * A Sent row whose last message is the person's Re-ask note (approval
 * "inbox-reask"): it stays Sent until the agent asks again, read or not.
 */
export function reaskRowLine(name: string, checkedAt: string | null, wakes: boolean | undefined): string {
  if (checkedAt) return `Asked ${name} to re-ask; waiting for its message.`;
  return wakes === true ? `Re-ask queued for ${name}; it gets this as its next turn.` : `Re-ask saved for ${name}. It sees it when it next reads this thread.`;
}

/** An item the Inbox marked to go in by itself that waited for the turn to end (its own Ask question held it). */
export const TURN_ENDED_TEXT = 'went in when its turn ended';

/** "went into its turn by itself after 5 min". */
export function autoAfterText(minutes: number): string {
  return `went into its turn by itself after ${minutes} min`;
}
