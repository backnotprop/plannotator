/**
 * Each linked machine's last good launch read, kept by the Inbox so a window opened while that machine sleeps still
 * lists its projects in New message (`launch_reads` on `GET /api/inbox/machines`). The failures this catches: a read
 * that failed or came back without a launch block leaving a stale or empty copy in the wrong way, an unlinked machine
 * kept again by a read that was still in flight, and a tailnet guest handed the owner's folder-trust facts.
 */
import { expect, test } from "bun:test";
import type { InboxComposeLaunch } from "@plannotator/core/inbox-types";
import { createMachineLaunchReads } from "./inbox-machine-launch-reads";

const MINI = "ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const BLOCK: InboxComposeLaunch = {
  agents: [{ agent: "claude-code", name: "Claude Code", untrusted: { prj_infra: { folder: "/Users/mini/code/infra", facts: ["Runs hooks"], warns: true } } }],
  projects: [{ id: "prj_infra", name: "infra", root: "/Users/mini/code/infra", exists: true }],
  scratch: { root: "/Users/mini/scratch" },
};
const answer = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const linked = () => true;

test("keeps the launch block and home of a sessions answer, not its live sessions", async () => {
  const reads = createMachineLaunchReads();
  await reads.keep(MINI, answer({ serverSession: "s", home: "/Users/mini", projects: [{ project: { id: "prj_infra" }, sessions: [{ session: "ses-1" }] }], launch: BLOCK }), linked);
  expect(reads.view([MINI], false)).toEqual({ [MINI]: { launch: BLOCK, home: "/Users/mini" } });
});

test("a failed or unreadable answer keeps the last read; one with no launch block forgets it", async () => {
  const reads = createMachineLaunchReads();
  await reads.keep(MINI, answer({ home: "/Users/mini", launch: BLOCK }), linked);
  await reads.keep(MINI, answer({ error: "nope" }, 500), linked);
  await reads.keep(MINI, answer("not json"), linked);
  expect(reads.view([MINI], false)[MINI]?.launch.projects[0]?.id).toBe("prj_infra");
  // Launch turned off there: its block is gone from the answer, so its projects go too.
  await reads.keep(MINI, answer({ home: "/Users/mini", projects: [] }), linked);
  expect(reads.view([MINI], false)).toEqual({});
});

test("a machine unlinked while its read was in flight is not kept, and forget drops it", async () => {
  const reads = createMachineLaunchReads();
  await reads.keep(MINI, answer({ home: "/Users/mini", launch: BLOCK }), () => false);
  expect(reads.view([MINI], false)).toEqual({});
  await reads.keep(MINI, answer({ home: "/Users/mini", launch: BLOCK }), linked);
  reads.forget(MINI);
  expect(reads.view([MINI], false)).toEqual({});
});

test("a tailnet guest gets the projects without the owner's folder-trust facts, and only machines still listed show", async () => {
  const reads = createMachineLaunchReads();
  await reads.keep(MINI, answer({ home: "/Users/mini", launch: BLOCK }), linked);
  const guest = reads.view([MINI], true)[MINI]!;
  expect(guest.launch.projects).toEqual(BLOCK.projects);
  expect(guest.launch.agents).toEqual([{ agent: "claude-code", name: "Claude Code" }]);
  // The owner's copy is untouched by the guest's.
  expect(reads.view([MINI], false)[MINI]!.launch.agents[0]!.untrusted).toEqual(BLOCK.agents[0]!.untrusted);
  expect(reads.view([], false)).toEqual({});
});
