/**
 * Branch reviews across linked machines (inbox-machine-branches.ts). What regresses:
 *  - a linked machine's report listed under another project or machine than its own;
 *  - a machine that doesn't take `branches` asked anyway, or one with Branch reviews off still listed;
 *  - a far answer's malformed row taken as a report, or its remote kept as typed (a password, a query, another
 *    scheme) where the words here would show it;
 *  - the read repeated on every list read (it is never on a timer, and a fresh read is reused).
 */
import { describe, expect, test } from "bun:test";
import type { PeerLink } from "./inbox-peer-link";
import { createMachineBranches, farBranchRow } from "./inbox-machine-branches";

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
