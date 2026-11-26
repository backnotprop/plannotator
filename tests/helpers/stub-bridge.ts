import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxContinuations, parseInboxContinues } from "../../packages/server/inbox-continuations";

export function stubBridge(dataDir: string, store: InboxStore) {
  const polls = new Map<string, { count: number; last: number }>();
  const busy = new Map<string, boolean>();
  const handed = new Map<string, number>();
  const isLive = (session: string) => {
    const entry = polls.get(session);
    return !!entry && Date.now() - entry.last < 2_000;
  };
  // A poll's `continues`, as the Inbox's bridge takes it (inbox-continuations.ts): while an old id does not poll, the
  // session continuing it is handed what waits for it, and the delivery is recorded for the old id (`actingFor`).
  const continuations = createInboxContinuations({ isLive });
  /** The old id a command was handed for, when a continuing session took it. */
  const handedAs = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const pathname = new URL(req.url).pathname;
      if (pathname === "/api/inbox/bridge/event") {
        const event = (await req.json()) as { session: string; host: string; type: string; id?: string; busy?: boolean };
        if (event.type === "delivered" && event.id) store.recordDelivery(event.id, { host: event.host, session: handedAs.get(event.id) ?? event.session });
        if (event.type === "state") busy.set(event.session, event.busy === true);
        return Response.json({ ok: true });
      }
      if (pathname !== "/api/inbox/bridge/poll") return Response.json({});
      const { session, host, continues } = (await req.json()) as { session: string; host: string; continues?: unknown };
      const entry = polls.get(session) ?? { count: 0, last: 0 };
      entry.count += 1;
      entry.last = Date.now();
      polls.set(session, entry);
      continuations.claim(session, parseInboxContinues(continues, session));
      await Bun.sleep(100);
      const inherited = continuations.inheritedBy(session).flatMap((old) => store.pendingReplies(old, { tags: true }).map((message) => ({ message, old })));
      const commands = store
        .threadIds()
        .map((id) => store.message(id))
        .filter((root): root is InboxMessage => !!root && root.to?.host === host && root.to.session === session)
        .concat(store.pendingReplies(session, { tags: true }))
        .concat(inherited.map(({ message, old }) => (handedAs.set(message.id, old), message)))
        .filter((message) => !handed.has(message.id) || (!store.message(message.id)?.delivery && Date.now() - handed.get(message.id)! > 1_000))
        .map((message) => (handed.set(message.id, Date.now()), { id: message.id, body: message.body }));
      return Response.json({ commands });
    },
  });
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ port: server.port, token: "test" }));
  return {
    polls,
    runStateOf: (session: string) => {
      const entry = polls.get(session);
      return entry && Date.now() - entry.last < 2_000 ? { busy: busy.get(session) === true, busySince: null, polls: entry.count } : null;
    },
    stop: () => server.stop(true),
  };
}

