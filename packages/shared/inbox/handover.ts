import { existsSync } from "node:fs";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { inboxClaimDirs } from "./claims";
import type { InboxHolder } from "./take-back";

export const INBOX_ASK_HOLD_MS = 10_000;

interface Hand {
  session: string;
  way: string;
  until: number | null;
  batch: ReadonlySet<string> | null;
}

export interface InboxHandoverStore {
  readonly dir: string;
  message(id: string): InboxMessage | null;
  recipientOf(message: InboxMessage): { host: string | null; session: string } | null;
  heldBy(message: InboxMessage): InboxHolder | null;
}

export interface InboxHandover {
  hand(item: InboxMessage, session: string, way: string): boolean;
  asked(items: readonly InboxMessage[], session: string): void;
  read(ids: Iterable<string>, reader: string | null): void;
  giveBack(messageId: string, session: string): void;
  holder(message: InboxMessage): InboxHolder | null;
  handedTo(session: string): string[];
}

export function createInboxHandover(store: InboxHandoverStore, now: () => number): InboxHandover {
  const hands = new Map<string, Hand[]>();
  const sessions = new Map<string, Set<string>>();

  const record = (id: string, hand: Hand) => {
    hands.set(id, [...(hands.get(id) ?? []).filter((h) => h.session !== hand.session || h.way !== hand.way), hand]);
    (sessions.get(id) ?? sessions.set(id, new Set()).get(id)!).add(hand.session);
  };
  const claimed = (id: string, session: string) => inboxClaimDirs(store.dir, id, session).some((dir) => existsSync(dir));
  const taken = (id: string, session: string) => {
    const message = store.message(id);
    return !message || !!message.delivery || !!message.tags?.some((t) => t.session === session && t.delivery) || claimed(id, session);
  };
  const live = (id: string, hand: Hand) => {
    if (hand.until === null) return true;
    if (now() >= hand.until) return false;
    return ![...(hand.batch ?? [])].some((other) => other !== id && taken(other, hand.session));
  };
  const hostOf = (message: InboxMessage, session: string) => {
    const owner = store.recipientOf(message);
    if (owner?.session === session) return owner.host;
    return message.tags?.find((t) => t.session === session)?.host ?? null;
  };
  const recipients = (message: InboxMessage) => [store.recipientOf(message)?.session, ...(message.tags ?? []).map((t) => t.session)].filter((s): s is string => !!s);

  const hand = (item: InboxMessage, session: string, way: string) => {
    const fresh = store.message(item.id);
    if (!fresh || fresh.taken_back_at) return false;
    record(item.id, { session, way, until: null, batch: null });
    return true;
  };

  return {
    hand,
    asked(items, session) {
      const open = items.filter((item) => !item.taken_back_at && !taken(item.id, session));
      const batch = new Set(open.map((item) => item.id));
      const until = now() + INBOX_ASK_HOLD_MS;
      for (const item of open) record(item.id, { session, way: "ask", until, batch });
    },
    read(ids, reader) {
      for (const id of ids) {
        const item = store.message(id);
        if (item?.author.kind === "person" && !store.heldBy(item)) hand(item, reader ?? "", "read");
      }
    },
    giveBack(messageId, session) {
      const left = (hands.get(messageId) ?? []).filter((h) => h.session !== session || h.until !== null);
      if (left.length > 0) hands.set(messageId, left);
      else hands.delete(messageId);
    },
    handedTo(session) {
      const out: string[] = [];
      for (const [id, list] of hands) {
        const message = store.message(id);
        if (message && !message.delivery && !message.taken_back_at && list.some((h) => h.session === session && h.until === null && h.way !== "read")) out.push(id);
      }
      return out;
    },
    holder(message) {
      const standing = (hands.get(message.id) ?? []).filter((h) => live(message.id, h));
      if (standing.length > 0) hands.set(message.id, standing);
      else hands.delete(message.id);
      const held = (by: InboxHolder["by"], session: string): InboxHolder => ({ by, session: session || null, host: hostOf(message, session) });
      const kept = standing.find((h) => h.until === null);
      if (kept) return held(kept.way === "read" ? "read" : "handed", kept.session);
      for (const session of new Set([...recipients(message), ...(sessions.get(message.id) ?? [])])) if (claimed(message.id, session)) return held("handed", session);
      return standing[0] ? held("handing", standing[0].session) : null;
    },
  };
}
