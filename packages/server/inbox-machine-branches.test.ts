/**
 * Branch reviews across linked machines (inbox-machine-branches.ts). What regresses:
 *  - a linked machine's report listed under another project or machine than its own;
 *  - a machine that doesn't take `branches` asked anyway, or one with Branch reviews off still listed;
 *  - a far answer's malformed row taken as a report, or its remote kept as typed (a password, a query, another
 *    scheme) where the words here would show it;
 *  - the read repeated on every list read (it is never on a timer, and a fresh read is reused);
 *  - a restart here while that machine sleeps losing its rows until it wakes, or rows kept after its link went.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerLink } from "./inbox-peer-link";
import { createMachineBranches, farBranchRow, MACHINE_BRANCHES_FILE } from "./inbox-machine-branches";

const B = "ibx_01JD000000000000000000000B";
const C = "ibx_01JD000000000000000000000C";
const THREAD = "msg_01JD0000000000000000000000";

const far = { thread_id: THREAD, project_id: "prj_on_b", branch: "retry-jitter", base: "main", head: "a".repeat(40), place: "here", remote_url: null, summary: null, at: "2026-11-16T10:00:00.000Z", reports: 1, agent: null, reachable: true, risk: { level: "medium", why: "Touches retries." }, risk_failed: null };

function peer(id: string, marks: string[], answer: () => Response, asked: string[]) {
  return {
    id,
    state: "online",
    list: { marks },
    request: async (route: string) => {
      asked.push(`${id} ${route}`);
      return answer();
    },
  } as unknown as PeerLink;
}

describe("a linked machine's reported branches", () => {
  test("listed under that machine and its own project; a machine without the mark is never asked", async () => {
    const asked: string[] = [];
    let clock = 0;
    const branches = createMachineBranches({ now: () => clock, peers: () => [peer(B, ["branches"], () => Response.json({ reports: [far, { thread_id: "nope" }] }), asked), peer(C, ["pulls"], () => Response.json({ reports: [far] }), asked)] });
    branches.start(() => "Mac mini");
    await branches.settled();
    const snapshot = branches.start((id) => (id === B ? "Mac mini" : null))();
    expect(snapshot.rows).toEqual([{ ...far, place: "here", machine: { id: B, name: "Mac mini" } } as never]);
    expect(snapshot.rows[0]!.project_id).toBe("prj_on_b");
    // Read once: the second list read came within the fresh window.
    expect(asked).toEqual([`${B} reviews/branches`]);
    clock = 60_000;
    branches.start(() => null);
    await branches.settled();
    expect(asked).toHaveLength(2);
  });

  test("Branch reviews off on that machine (409): nothing of it listed", async () => {
    const asked: string[] = [];
    let status = 200;
    let clock = 0;
    const branches = createMachineBranches({ now: () => clock, peers: () => [peer(B, ["branches"], () => (status === 200 ? Response.json({ reports: [far] }) : Response.json({ code: "branch_reviews_off" }, { status })), asked)] });
    branches.start(() => null);
    await branches.settled();
    expect(branches.start(() => null)().rows).toHaveLength(1);
    status = 409;
    clock = 60_000;
    branches.start(() => null);
    await branches.settled();
    expect(branches.start(() => null)().rows).toHaveLength(0);
  });

  test("a branch read started before unlink cannot restore stale reports after re-link", async () => {
    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    const old = peer(B, ["branches"], () => Response.json({ reports: [far] }), []);
    const request = old.request.bind(old);
    old.request = async (...args) => {
      await held;
      return request(...args);
    };
    const current = peer(B, ["branches"], () => Response.json({ reports: [{ ...far, branch: "fresh-branch" }] }), []);
    let linked = [old];
    const branches = createMachineBranches({ peers: () => linked });
    branches.start(() => null);
    const stale = branches.settled();
    branches.forget(B);
    linked = [current];
    const snapshot = branches.start(() => null);

    release();
    await stale;
    await branches.settled();
    expect(snapshot().rows.map((row) => row.branch)).toEqual(["fresh-branch"]);
  });

  test("a restart while that machine sleeps keeps its rows; its link going takes them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-machine-branches-"));
    try {
      const awake = peer(B, ["branches"], () => Response.json({ reports: [far] }), []);
      const first = createMachineBranches({ peers: () => [awake], dir });
      first.start(() => null);
      await first.settled();
      expect(first.start(() => null)().rows).toHaveLength(1);
      // This Inbox restarts; B is asleep: no list read from it yet, and its door does not answer.
      const asleep = { ...peer(B, [], () => Response.json({}, { status: 502 }), []), state: "offline", list: null } as unknown as PeerLink;
      const again = createMachineBranches({ peers: () => [asleep], dir });
      const rows = again.start(() => "Mac mini")().rows;
      expect(rows.map((row) => [row.branch, row.machine.id, row.machine.name])).toEqual([["retry-jitter", B, "Mac mini"]]);
      expect(statSync(join(dir, MACHINE_BRANCHES_FILE)).mode & 0o777).toBe(0o600);
      // The link goes: nothing of it stays, after another restart too.
      again.forget(B);
      expect(createMachineBranches({ peers: () => [asleep], dir }).start(() => null)().rows).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a machine unlinked while this Inbox was down leaves nothing behind: linked again later, its old rows never come back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-machine-branches-"));
    try {
      const awake = peer(B, ["branches"], () => Response.json({ reports: [far] }), []);
      const first = createMachineBranches({ peers: () => [awake], dir, linked: () => [B] });
      first.start(() => null);
      await first.settled();
      expect(first.start(() => null)().rows).toHaveLength(1);
      // B was unlinked while this Inbox was down: the restart reads the file with B no longer linked.
      createMachineBranches({ peers: () => [], dir, linked: () => [] });
      // B is linked again and sleeps (no list read from it yet): none of its rows from before the unlink.
      const asleep = { ...peer(B, [], () => Response.json({}, { status: 502 }), []), state: "offline", list: null } as unknown as PeerLink;
      expect(createMachineBranches({ peers: () => [asleep], dir, linked: () => [B] }).start(() => null)().rows).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the file is written only when a read changes it, and a machine that stops taking branches leaves it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-machine-branches-"));
    try {
      let clock = 0;
      let marks = ["branches"];
      const b = { ...peer(B, [], () => Response.json({ reports: [far] }), []), get list() { return { marks }; } } as unknown as PeerLink;
      const branches = createMachineBranches({ now: () => clock, peers: () => [b], dir });
      branches.start(() => null);
      await branches.settled();
      const path = join(dir, MACHINE_BRANCHES_FILE);
      const first = statSync(path).mtimeMs;
      await Bun.sleep(20);
      clock = 60_000;
      branches.start(() => null);
      await branches.settled();
      expect(statSync(path).mtimeMs).toBe(first);
      // Branch reviews turned off there: its list no longer takes `branches`; nothing of it after a restart either.
      marks = ["pulls"];
      expect(branches.start(() => null)().rows).toEqual([]);
      const asleep = { ...peer(B, [], () => Response.json({}, { status: 502 }), []), state: "offline", list: null } as unknown as PeerLink;
      expect(createMachineBranches({ peers: () => [asleep], dir }).start(() => null)().rows).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a far row is taken by its shape only", () => {
    expect(farBranchRow(far)).toMatchObject({ branch: "retry-jitter", risk: { level: "medium" } });
    expect(farBranchRow({ ...far, place: "elsewhere" })).toBeNull();
    expect(farBranchRow({ ...far, thread_id: "../x" })).toBeNull();
    expect(farBranchRow({ ...far, risk: { level: "critical", why: "x" } })).toMatchObject({ risk: null });
    expect(farBranchRow({ ...far, branch: "--upload-pack=x" })).toBeNull();
    expect(farBranchRow({ ...far, base: "main;rm" })).toBeNull();
    expect(farBranchRow({ ...far, head: "not-a-commit" })).toBeNull();
  });

  test("a far row's remote is read by the same rules as a report here: rebuilt, or none", () => {
    expect(farBranchRow({ ...far, place: "cloud", remote_url: "https://bot:s3cret@github.com/acme/app.git?token=x#f" })?.remote_url).toBe("https://github.com/acme/app.git");
    for (const remote_url of ["ext::sh -c x", "file:///etc", "javascript:alert(1)", "http://github.com/acme/app.git"]) {
      expect(farBranchRow({ ...far, place: "cloud", remote_url })?.remote_url).toBeNull();
    }
  });
});
