import { expect, test } from "bun:test";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { linkInboxPulls } from "./inbox-pulls";

const REPO = "northwind/web-app";
const pull = { key: `github.com/${REPO}#880`, host: "github.com", repo: REPO, number: 880, url: `https://github.com/${REPO}/pull/880`, title: "PR 880", state: "open" } as InboxPull;
const at = (i: number) => new Date(Date.UTC(2026, 10, 18, 9, 0, i)).toISOString();

function longThread(count: number, page: number | null) {
  const ids = Array.from({ length: count }, (_, i) => (i === 0 ? "thr_a" : `msg_${i}`));
  const agent = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
  const messages = new Map(
    ids.map((id, i) => [
      id,
      {
        id,
        thread_id: "thr_a",
        project_id: "prj_web",
        created_at: at(i),
        author: i === 0 ? { kind: "person" } : agent,
        body: `Message ${i}`,
        to: { host: "claude-code", session: "ses_a" },
        ...(i === count - 1 ? { guide: { title: "Review", sections: 3 } } : {}),
        ...(i === page ? { picture_it: { attachment_id: "att_1", title: "Retries" } } : {}),
      },
    ]),
  );
  const reads = { count: 0 };
  const store = {
    threadsOf: () => [],
    threadMessageIds: () => ids,
    message: (id: string) => (reads.count++, (messages.get(id) as never) ?? null),
    threadSubject: () => "Review #880",
    threadProject: () => "prj_web",
  };
  return { store, reads };
}

test("a PR list reads only a linked thread's newest messages: never the whole thread for a Picture page it was not asked for, nor before the ask", () => {
  const projects = new Map([[`github.com/${REPO}`, ["prj_web"]]]);
  const plain = longThread(500, 10);
  const link = linkInboxPulls([pull], plain.store, projects, new Map([[pull.key, { thread_id: "thr_a", ask: "guide" as const }]]))[pull.key]!;
  expect(link.picture_it_page).toBeUndefined();
  expect(plain.reads.count).toBeLessThan(10);
  const asked = longThread(500, 495);
  const found = linkInboxPulls([pull], asked.store, projects, new Map([[pull.key, { thread_id: "thr_a", picture_it_at: at(490) }]]))[pull.key]!;
  expect(found.picture_it_page).toMatchObject({ message_id: "msg_495", title: "Retries" });
  expect(asked.reads.count).toBeLessThan(30);
  const early = longThread(500, 10);
  expect(linkInboxPulls([pull], early.store, projects, new Map([[pull.key, { thread_id: "thr_a", picture_it_at: at(490) }]]))[pull.key]!.picture_it_page).toBeUndefined();
  expect(early.reads.count).toBeLessThan(30);
});
