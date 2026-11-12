/// <reference types="bun-types" />
/**
 * The import's check (`import.ts`): one SHA-256 over everything a store serves that a move between logs could
 * change, read through the store's own public reads, so two stores (over the files and over the new database)
 * compare whole without holding both in memory. Beside it, counts per kind and per thread (no words) for the
 * report when they differ.
 *
 * Covered: the cursor; every record's latest line (`changesSince(0)`: its seq, time, version and record); each
 * thread's messages in order with their first seq, its archive line, who may still name it and its PR events;
 * each card as the Board reads it (its unread seq included); hashtag threads per initiative; each session's
 * latest message.
 */
import type { InboxStore } from "../../store";

export interface InboxStoreDigest {
  sha256: string;
  counts: { kinds: Record<string, number>; threads: Record<string, number> };
}

export function inboxStoreDigest(store: InboxStore): InboxStoreDigest {
  const hash = new Bun.CryptoHasher("sha256");
  const put = (label: string, value: unknown) => {
    hash.update(label);
    hash.update(JSON.stringify(value) ?? "null");
    hash.update("\n");
  };
  const kinds: Record<string, number> = {};
  const threads: Record<string, number> = {};
  put("cursor", store.cursor());
  for (const line of store.changesSince(0)) {
    kinds[line.kind] = (kinds[line.kind] ?? 0) + 1;
    put("line", [line.kind, line.id, line.seq, line.at, line.v, line.record]);
  }
  for (const id of store.threadIds()) {
    const members = store.threadMessageIds(id);
    threads[id] = members.length;
    put("thread", [id, members.map((m) => [m, store.messageCursor(m)]), store.archiveSeq(id), store.threadNamers(id), store.threadPullEvents(id)]);
  }
  for (const card of store.listCards()) put("card", store.cardWire(card));
  put("tagged", store.initiativeThreads());
  put("agents", [...store.latestAgentMessages()].map(([session, message]) => [session, message.id]));
  return { sha256: hash.digest("hex"), counts: { kinds, threads } };
}
