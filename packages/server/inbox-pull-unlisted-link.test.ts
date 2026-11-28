/**
 * A teammate's PR leaves the list once merged (only the person's own merged PRs are listed), so its merged ship's
 * Reviews row needs the link the person tied it with (`linkUnlistedPulls`). What regresses: the tie not linked (the row
 * vanishes at merge), linked without its ask (the row lands in the wrong group), or a link already made overwritten.
 */
import { expect, test } from "bun:test";
import type { InboxPullLink } from "@plannotator/core/inbox-types";
import { linkUnlistedPulls } from "./inbox-pulls";

const KEY = "github.com/northwind/web-app#880";

const store = {
  threadsOf: () => [],
  threadMessageIds: (thread: string) => [thread],
  message: (id: string) => (id === "msg_s" ? ({ id, thread_id: id, project_id: "prj_web", created_at: "2026-11-24T10:00:00.000Z", author: { kind: "person" }, body: "Ship it", to: { host: "claude-code", session: "ses_a" } } as never) : null),
  threadSubject: () => "Review #880",
  threadProject: (id: string) => (id === "msg_s" ? "prj_web" : null),
};

test("an unlisted PR the person tied to a thread is linked as a listed one would be; a link made already stays", () => {
  const links: Record<string, InboxPullLink> = {};
  linkUnlistedPulls([KEY, "github.com/northwind/web-app#881"], links, store as never, new Map([[KEY, { thread_id: "msg_s", ask: "thread" as const }], ["github.com/northwind/web-app#881", { thread_id: "msg_gone" }]]));
  expect(Object.keys(links)).toEqual([KEY]);
  expect(links[KEY]).toMatchObject({ via: "owner", thread_id: "msg_s", project_id: "prj_web", ask: "thread", thread_subject: "Review #880" });
  const made = { ...links[KEY]!, via: "url" as const };
  links[KEY] = made;
  linkUnlistedPulls([KEY], links, store as never, new Map([[KEY, { thread_id: "msg_s" }]]));
  expect(links[KEY]).toBe(made);
});
