/**
 * Share this space as the Inbox runs it: the job per plan, its routes, the sign-in and the credential file, against
 * the stand-in (tests/helpers/fake-spaces.ts; the only socket is the sign-in's own listener on 127.0.0.1). What
 * regresses if these fail:
 * - the status says the wrong thing (a link before there is one, "shared" while a run is going, changes after
 *   nothing changed), or carries the sign-in token to the page;
 * - Keep does not make the space the person's own, loses the race quietly, or sends the approval before the claim;
 * - Keep's sign-in page is not told the space and the approval of the version it holds, a Cancel there changes
 *   anything, a claim lost there is not "someone else kept it", or what the page did with the approval is not kept;
 * - the token lands in a file others can read, in a URL, or stays after the space refused it;
 * - Stop sharing forgets a space that was not deleted, or deletes one nobody kept;
 * - the address resolver takes plain http to another machine, or the switch is on by default.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeSpaces } from "../../../tests/helpers/fake-spaces";
import { seedSpaceShareWorld, type SpaceShareWorld } from "../../../tests/helpers/space-share-world";
import { NO_ACTOR } from "@plannotator/core/plans";
import { clearSpacesCredential, readSpacesCredential, saveSpacesCredential, spacesCredentialPath } from "./credential";
import { readSpaceShareRecord } from "./record";
import { createSpaceShareJobs, handleSpaceShareRoute, type SpaceShareJobsOptions } from "./share-job";
import { DEFAULT_SPACES_URL, isLoopbackSpacesUrl, normalizeSpacesUrl, resolveSpacesUrl, spaceShareOn } from "./url";

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOST = "http://127.0.0.1:1";
const enc = (text: string) => new TextEncoder().encode(text);

/** The person approves version `n` of the main page here, as plan review records it. */
function approveHere(s: { world: { store: SpaceShareWorld["store"]; plan: string; main: string } }, n: number) {
  const at = new Date().toISOString();
  const version = s.world.store.versions(s.world.plan, s.world.main).find((v) => v.version_number === n)!.version;
  s.world.store.addEvent(s.world.plan, { ...NO_ACTOR, author_via: "person", kind: "decision", at, subject: { document_id: s.world.main, version_number: n }, decision: { document_id: s.world.main, version, version_number: n, decision: "approved", at, feedback: null, feedback_record: null, snapshot: null }, legacy: null });
}

function setup(options: { spaces?: Parameters<typeof createFakeSpaces>[0]; jobs?: Partial<SpaceShareJobsOptions>; seed?: Parameters<typeof seedSpaceShareWorld>[1] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "space-share-job-"));
  dirs.push(dataDir);
  const world = seedSpaceShareWorld(dataDir, options.seed);
  const spaces = createFakeSpaces({ origin: HOST, ...options.spaces });
  const opened: string[] = [];
  const jobs = createSpaceShareJobs({
    dataDir,
    store: () => world.store,
    host: () => HOST,
    fetch: spaces.fetch,
    remote: () => false,
    // The "browser": it goes to the sign-in page, is sent back, and lands on this computer's listener.
    openBrowser: async (url) => {
      opened.push(url);
      const login = await spaces.fetch(url, { redirect: "manual" });
      const back = login.headers.get("location");
      if (back) await fetch(back);
      return "opened";
    },
    sleep: async () => spaces.resetWrites(),
    ...options.jobs,
  });
  closers.push(() => jobs.close());
  const record = () => readSpaceShareRecord(dataDir, world.plan)!;
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const running = jobs.running(world.plan);
      const claiming = jobs.claiming(world.plan);
      if (running) await running;
      else if (claiming) await claiming;
      else if (jobs.status(world.plan)!.keep !== "waiting") return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { dataDir, world, spaces, jobs, opened, record, settle };
}

describe("the status", () => {
  test("never shared, sharing, shared with its link, then Update only when something is new", async () => {
    const s = setup();
    const id = s.world.plan;
    expect(s.jobs.status(id)).toMatchObject({ phase: "none", link: null, versions: 4, signed_in: false, kept: false, access: "edit", changes: 0 });
    expect(s.jobs.status(id)!.details.all).toEqual({ pages: 4, files: 3, comments: 1, approval: null, not: { sent_comments: 3, pictures: 2, original_dates: true, files_over: 0, pages_over: 0, long_comments: 0, older_approvals: 0 } });
    expect(s.jobs.share(id, { mode: "all" })).toMatchObject({ phase: "sharing" });
    await s.settle();
    const shared = s.jobs.status(id)!;
    expect(shared).toMatchObject({ phase: "shared", shared_once: true, kept: false, changes: 0, progress: null, mode: "all" });
    expect(shared.link).toBe(s.spaces.spaces.get(s.record().space_id)!.share_url);
    s.world.store.addVersion(id, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    s.world.store.saveComment(id, { document_id: s.world.main, document_version: s.world.store.versions(id, s.world.main)[4]!.version, annotation: { id: "open-2", text: "And Team?" }, at: new Date().toISOString() });
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", changes: 2 });
    s.jobs.share(id, {});
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", changes: 0 });
    expect(s.spaces.spaces.size).toBe(1);
  });

  test("a run that did not finish says so with its count, and Try again finishes it", async () => {
    const s = setup();
    s.spaces.failNext(/assets\//, 502, "bad_gateway");
    s.jobs.share(s.world.plan, { mode: "newest" });
    await s.settle();
    const failed = s.jobs.status(s.world.plan)!;
    expect(failed).toMatchObject({ phase: "failed", shared_once: false, mode: "newest" });
    expect(failed.progress!.done).toBeLessThan(failed.progress!.total);
    expect(failed.link).not.toBeNull();
    s.jobs.share(s.world.plan, {});
    await s.settle();
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "shared", progress: null });
  });

  test("a page changed in the space is named; a space someone else kept is refused until shared as new", async () => {
    const s = setup();
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    const first = s.record().space_id;
    s.spaces.editPage(first, "Rollout checklist.md", "# Rollout checklist\n\nEdited there.\n");
    s.world.store.addVersion(id, s.world.pages.rollout, { bytes: enc("# Rollout checklist\n\nv3\n"), committed_at: new Date().toISOString(), source: "agent-tool" });
    s.jobs.share(id, {});
    await s.settle();
    const link = s.jobs.status(id)!.link!;
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", link, stopped_pages: [{ title: "Rollout checklist" }], changes: 0 });
    s.spaces.keptBy(first, "Someone Else");
    s.world.store.addVersion(id, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    s.jobs.share(id, {});
    await s.settle();
    // The write was not allowed: Keep is offered, the changes still wait, and nothing says whose the space is.
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", needs_keep: true, own: false, access: "comment", kept: false });
    expect(s.jobs.status(id)!.changes).toBeGreaterThan(0);
    const waiting = s.spaces.calls.length;
    s.jobs.share(id, {});
    await s.settle();
    expect(s.spaces.calls.length).toBe(waiting);
    // Keep signs in and claims: the claim is what says it is someone else's.
    await s.jobs.keep(id);
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "refused" });
    // Update again does nothing; Share as new makes a second space with its own link.
    const calls = s.spaces.calls.length;
    s.jobs.share(id, {});
    await s.settle();
    expect(s.spaces.calls.length).toBe(calls);
    s.jobs.share(id, { fresh: true });
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", stopped_pages: [] });
    expect(s.record().space_id).not.toBe(first);
    expect(s.spaces.spaces.size).toBe(2);
  });
});

describe("a write that is not allowed", () => {
  test("the person kept it themselves elsewhere: Keep finds it is theirs, and the Update goes on", async () => {
    const s = setup();
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    // Kept from the browser, as the same person the sign-in here will be.
    s.spaces.keptBy(s.record().space_id, "Maya Chen");
    s.world.store.addVersion(id, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    s.jobs.share(id, {});
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", needs_keep: true, changes: 1 });
    expect(s.record().refused).toBe(false);
    await s.jobs.keep(id);
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", kept: true, needs_keep: false, changes: 0, access: "comment" });
    expect(s.spaces.spaces.get(s.record().space_id)!.documents.find((d) => d.doc_path.startsWith("Rate limiting"))!.versions).toHaveLength(5);
    expect(s.spaces.spaces.size).toBe(1);
    // Made with no account: no key on the create. The Update after Keep is the owner's imported save, and it went up.
    expect(s.spaces.calls.find((c) => c.method === "POST" && c.path === "/v1/workspaces")!.json).not.toHaveProperty("external_key");
    const update = s.spaces.calls.filter((c) => c.method === "PATCH" && c.signedIn);
    expect(update.map((c) => [c.status, (c.json as { actor: { kind: string } }).actor.kind])).toEqual([[200, "imported"]]);
  });
});

describe("started signed in", () => {
  test("the sign-in is gone before the space was made: nothing is ever made without it, and Keep is the way on", async () => {
    const s = setup({ seed: { extras: false } });
    const id = s.world.plan;
    saveSpacesCredential(s.dataDir, HOST, { token: s.spaces.issueToken("Maya Chen"), name: "Maya Chen" });
    s.spaces.failNext(/^POST \/v1\/workspaces$/, 502, "bad_gateway");
    s.jobs.share(id, {});
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "failed", needs_keep: false, access: "private" });
    clearSpacesCredential(s.dataDir, HOST);
    const calls = s.spaces.calls.length;
    s.jobs.share(id, {});
    await s.settle();
    expect(s.spaces.calls.length).toBe(calls);
    expect(s.spaces.spaces.size).toBe(0);
    // Started signed in: it counts as the person's own, so "Only you" never sits beside "Make it yours".
    expect(s.jobs.status(id)).toMatchObject({ phase: "failed", needs_keep: true, own: true, access: "private", signed_in: false });
    expect(s.opened).toEqual([]);
    await s.jobs.keep(id);
    await s.settle();
    // Nothing was made yet: the sign-in page is told no space and no approval.
    const login = new URL(s.opened[0]!);
    expect(login.searchParams.get("client_name")).toBe("Plannotator");
    expect(["space", "approve_document", "approve_version"].filter((k) => login.searchParams.has(k))).toEqual([]);
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", kept: true, access: "private" });
    expect([...s.spaces.spaces.values()].map((space) => space.owner)).toEqual(["Maya Chen"]);
  });

  test("a 401 that is not the space refusing the credential keeps the sign-in", async () => {
    const s = setup({ seed: { extras: false } });
    saveSpacesCredential(s.dataDir, HOST, { token: s.spaces.issueToken("Maya Chen"), name: "Maya Chen" });
    s.spaces.failNext(/^POST \/v1\/workspaces$/, 401, "login_required");
    s.jobs.share(s.world.plan, {});
    await s.settle();
    expect(readSpacesCredential(s.dataDir, HOST)).not.toBeNull();
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "failed", signed_in: true, needs_keep: false });
  });
});

describe("over the limit", () => {
  test("the person's own space: its own state, the link kept, and never sent again until what it holds changes", async () => {
    const s = setup({ seed: { extras: false } });
    const id = s.world.plan;
    saveSpacesCredential(s.dataDir, HOST, { token: s.spaces.issueToken("Maya Chen"), name: "Maya Chen" });
    s.world.store.addArtifact(id, { asset_path: "a.bin", content_type: "application/octet-stream", created_at: new Date().toISOString(), bytes: new Uint8Array([1, 2, 3]) });
    s.spaces.failNext(/assets\//, 413, "quota_exceeded", { times: 2 });
    s.jobs.share(id, {});
    await s.settle();
    const over = s.jobs.status(id)!;
    expect(over).toMatchObject({ phase: "over_limit", limit_own: true, kept: true });
    expect(over.link).not.toBeNull();
    // Try again sends once and, still over, lands on the same state: one call, no loop, nothing by itself.
    const calls = s.spaces.calls.length;
    s.jobs.share(id, {});
    await s.settle();
    expect(s.spaces.calls.length).toBe(calls + 1);
    expect(s.jobs.status(id)).toMatchObject({ phase: "over_limit", limit_own: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect([s.spaces.calls.length, s.jobs.running(id)]).toEqual([calls + 1, null]);
    // Room was made in the space: the next Try again finishes.
    s.jobs.share(id, {});
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", limit_own: false });
  });

  test("never finished, and what it holds here changed: the first share again, not a Stop the person never pressed", async () => {
    const s = setup({ seed: { extras: false } });
    const id = s.world.plan;
    saveSpacesCredential(s.dataDir, HOST, { token: s.spaces.issueToken("Maya Chen"), name: "Maya Chen" });
    s.world.store.addArtifact(id, { asset_path: "a.bin", content_type: "application/octet-stream", created_at: new Date().toISOString(), bytes: new Uint8Array([1, 2, 3]) });
    s.spaces.failNext(/assets\//, 413, "quota_exceeded");
    s.jobs.share(id, {});
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "over_limit", limit_own: true });
    s.world.store.addArtifact(id, { asset_path: "a.bin", content_type: "application/octet-stream", created_at: new Date().toISOString(), bytes: new Uint8Array([1]) });
    expect(s.jobs.status(id)).toMatchObject({ phase: "none", limit_own: false, progress: null, access: "private" });
    s.jobs.share(id, {});
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", kept: true });
    expect(s.spaces.spaces.size).toBe(1);
  });

  test("a space nobody kept: the sign-in state, as before", async () => {
    const s = setup({ spaces: { openQuota: 80 } });
    s.jobs.share(s.world.plan, {});
    await s.settle();
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "over_limit", limit_own: false });
  });
});

describe("going down", () => {
  test("a run cut by the server going down is left as a run not finished, never as stopped by the person", async () => {
    const s = setup({ jobs: { sleep: (_ms, signal) => new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })) } });
    s.spaces.failNext(/assets\//, 429, "rate_limited");
    s.jobs.share(s.world.plan, {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "sharing" });
    const running = s.jobs.running(s.world.plan);
    s.jobs.close();
    await running;
    expect(s.record().job).toMatchObject({ ended: null });
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "failed" });
  });
});

describe("a space that is no longer there", () => {
  test("removed there, then Update with no account: it did not finish, no sign-in is started, and Share as new makes a new space", async () => {
    const s = setup();
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    const first = s.record().space_id;
    s.spaces.remove(first);
    s.world.store.addVersion(id, s.world.main, { bytes: enc("# v5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    s.jobs.share(id, {});
    await s.settle();
    // Its own state: no dead link, nothing to try again, no sign-in started or suggested.
    expect(s.jobs.status(id)).toMatchObject({ phase: "gone", link: null, progress: null, keep: null, signed_in: false, needs_keep: false });
    expect(s.opened).toEqual([]);
    const calls = s.spaces.calls.length;
    s.jobs.share(id, {});
    await s.settle();
    expect([s.spaces.calls.length, s.spaces.spaces.size]).toEqual([calls, 1]);
    s.jobs.share(id, { fresh: true });
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared" });
    expect(s.jobs.status(id)!.link).not.toBeNull();
    expect(s.record().space_id).not.toBe(first);
  });

  test("a claim on a space that is not available (404) is not someone else's keep", async () => {
    const s = setup();
    s.jobs.share(s.world.plan, {});
    await s.settle();
    s.spaces.remove(s.record().space_id);
    saveSpacesCredential(s.dataDir, HOST, { token: s.spaces.issueToken("Maya Chen"), name: "Maya Chen" });
    await s.jobs.keep(s.world.plan);
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "shared", kept: false });
    expect(s.record().refused).toBe(false);
  });
});

describe("Keep this space", () => {
  test("signs in through the browser, keeps the token in a 0600 file; the page claims the space and records the approval", async () => {
    // A tool's own approval call is refused: the approval goes only by the sign-in page.
    const s = setup();
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    expect(s.spaces.calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
    // Approved here, not up there yet: Details lists no approval before Keep.
    expect(s.jobs.status(id)!.details.all.approval).toBeNull();
    const waiting = await s.jobs.keep(id);
    await s.settle();
    // The page the browser opened: the challenge and the way back to this computer, nothing secret.
    const login = new URL(s.opened[0]!);
    expect(login.origin + login.pathname).toBe(`${HOST}/cli/login`);
    expect(login.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(login.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(waiting).not.toBeNull();
    const credential = readSpacesCredential(s.dataDir, HOST)!;
    expect(credential.token).toMatch(/^wscli_live_/);
    expect(statSync(spacesCredentialPath(s.dataDir)).mode & 0o777).toBe(0o600);
    expect(statSync(join(s.dataDir, "secrets")).mode & 0o777).toBe(0o700);
    const status = s.jobs.status(id)!;
    // Kept after it was shared: holders of the link still read and comment, and the status says so.
    expect(status).toMatchObject({ phase: "shared", kept: true, access: "comment", signed_in: true, who: "Maya Chen", keep: null });
    // The token is in no answer to the page, no record and no address.
    expect(JSON.stringify(status)).not.toContain(credential.token);
    expect(readFileSync(join(s.dataDir, "plan-library", id, "share.json"), "utf8")).not.toContain(credential.token);
    expect(s.spaces.calls.some((c) => `${c.path}${c.query}`.includes(credential.token))).toBe(false);
    expect(s.opened.join(" ")).not.toContain(credential.token);
    const space = s.spaces.spaces.get(s.record().space_id)!;
    expect(space.owner).toBe("Maya Chen");
    // The page was told the tool, the space, and the person's approval of the version the space holds.
    const main = s.record().pages[s.world.main]!;
    const held = main.pushed[main.pushed.length - 1]!.remote;
    expect([login.searchParams.get("client_name"), login.searchParams.get("space"), login.searchParams.get("approve_document"), login.searchParams.get("approve_version")]).toEqual(["Plannotator", space.id, main.remote_id, held]);
    expect(space.approvals).toEqual([{ document_id: main.remote_id!, version: held, by: "Maya Chen" }]);
    // What the page did is kept with the share, and the approval counts as up: no approval call follows.
    expect(s.record().keep_approval).toMatchObject({ outcome: "recorded", document_id: s.world.main, version_number: 4, version: held });
    expect(s.record().approval).toEqual({ document_id: s.world.main, version_number: 4 });
    expect(s.jobs.status(id)!.details.all.approval).toBe(4);
    // Nothing else waited: no run followed the claim (no "Sharing" from the approval), and no approval call.
    expect(s.spaces.calls[s.spaces.calls.length - 1]).toMatchObject({ method: "POST", path: `/v1/workspaces/${space.id}/claim` });
    expect(s.spaces.calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
    expect(s.record().approval_refused).toBeUndefined();

    // A new version saved there clears it there: approved here again, it is not up until a Keep records it.
    s.world.store.addVersion(id, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    approveHere(s, 5);
    expect(s.jobs.status(id)!.details.all.approval).toBeNull();
    s.jobs.share(id, {});
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", changes: 0 });
    expect(s.jobs.status(id)!.details.all.approval).toBeNull();
    expect(s.spaces.calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
  });

  test("signed in before the share: an approval here is never sent by a run and never listed until a Keep records it", async () => {
    const s = setup();
    const id = s.world.plan;
    saveSpacesCredential(s.dataDir, HOST, { token: s.spaces.issueToken("Maya Chen"), name: "Maya Chen" });
    s.jobs.share(id, {});
    await s.settle();
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", kept: true, changes: 0 });
    expect(s.jobs.status(id)!.details.all.approval).toBeNull();
    expect(s.spaces.calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
    // Keep while signed in claims again with no sign-in page: still not up, and nothing is sent for it.
    const calls = s.spaces.calls.length;
    await s.jobs.keep(id);
    await s.settle();
    expect(s.spaces.calls.slice(calls).map((c) => `${c.method} ${c.path.split("/").pop()}`)).toEqual(["POST claim"]);
    expect(s.jobs.status(id)!.details.all.approval).toBeNull();
  });

  test("the page said none: no approval listed, nothing sent for it", async () => {
    const s = setup({
      jobs: {
        // The browser lands back with the approval as `none`.
        openBrowser: async (url) => {
          const login = await s.spaces.fetch(url, { redirect: "manual" });
          const back = new URL(login.headers.get("location")!);
          back.searchParams.set("approval", "none");
          await fetch(back);
          return "opened";
        },
      },
    });
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    await s.jobs.keep(id);
    await s.settle();
    expect(s.record().keep_approval).toMatchObject({ outcome: "none", version_number: 4 });
    expect(s.record().approval).toBeNull();
    expect(s.jobs.status(id)!.details.all.approval).toBeNull();
    expect(s.spaces.calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
  });

  test("an old record that says the tool's approval was refused still loads, and a Keep records the approval", async () => {
    const s = setup();
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    const file = join(s.dataDir, "plan-library", id, "share.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), approval_refused: true }));
    expect(readSpaceShareRecord(s.dataDir, id)).toMatchObject({ approval_refused: true });
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared" });
    await s.jobs.keep(id);
    await s.settle();
    expect(s.record().keep_approval).toMatchObject({ outcome: "recorded" });
    expect(s.jobs.status(id)!.details.all.approval).toBe(4);
  });

  test("the page moved on there since the last push: the approval is not recorded, and the outcome says so", async () => {
    const s = setup();
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    s.spaces.editPage(s.record().space_id, s.record().pages[s.world.main]!.doc_path, "# Rate limiting\n\nEdited there.\n");
    await s.jobs.keep(id);
    await s.settle();
    expect(s.record().keep_approval).toMatchObject({ outcome: "moved", document_id: s.world.main, version_number: 4 });
    expect(s.spaces.spaces.get(s.record().space_id)!.approvals).toEqual([]);
    expect(s.jobs.status(id)!.details.all.approval).toBeNull();
    expect(s.spaces.calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", kept: true, signed_in: true });
  });

  test("a plan not approved: the page is told the space and no approval, and no outcome is kept", async () => {
    const s = setup({ seed: { approve: false } });
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    await s.jobs.keep(id);
    await s.settle();
    const login = new URL(s.opened[0]!);
    expect(login.searchParams.get("space")).toBe(s.record().space_id);
    expect(["approve_document", "approve_version"].filter((k) => login.searchParams.has(k))).toEqual([]);
    expect(s.record().keep_approval).toBeUndefined();
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", kept: true });
  });

  test("Cancel on the sign-in page: back to where it was before Keep, with nothing changed and no error", async () => {
    const s = setup({ spaces: { consent: "cancel" } });
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    const before = { status: s.jobs.status(id), record: readFileSync(join(s.dataDir, "plan-library", id, "share.json"), "utf8") };
    await s.jobs.keep(id);
    await s.settle();
    expect(s.opened).toHaveLength(1);
    expect(s.jobs.status(id)).toEqual(before.status!);
    expect(readFileSync(join(s.dataDir, "plan-library", id, "share.json"), "utf8")).toBe(before.record);
    expect(existsSync(spacesCredentialPath(s.dataDir))).toBe(false);
    expect(s.spaces.exchanges).toHaveLength(0);
  });

  test("a sign-in that comes back while a claim is already going: its approval outcome is still kept", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let hold = false;
    const pages: string[] = [];
    const via: { fetch: typeof fetch | null } = { fetch: null };
    const s = setup({
      jobs: {
        // The browser is left on the sign-in page; the test presses Allow itself, later.
        openBrowser: async (url) => {
          pages.push(url);
          return "opened";
        },
        // A claim made while `hold` is on waits until it is released.
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(String(input), init);
          if (hold && request.method === "POST" && new URL(request.url).pathname.endsWith("/claim")) await held;
          return via.fetch!(request);
        }) as typeof fetch,
      },
    });
    via.fetch = s.spaces.fetch;
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    expect(await s.jobs.keep(id)).toMatchObject({ keep: "waiting" });
    // Signed in meanwhile from elsewhere: Keep again claims at once, and that claim is slow.
    saveSpacesCredential(s.dataDir, HOST, { token: s.spaces.issueToken("Maya Chen"), name: "Maya Chen" });
    hold = true;
    void s.jobs.keep(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.jobs.claiming(id)).not.toBeNull();
    // Allow is pressed on the first page now: the page records the approval, and the sign-in joins the claim going.
    const login = await s.spaces.fetch(pages[0]!, { redirect: "manual" });
    expect(new URL(login.headers.get("location")!).searchParams.get("approval")).toBe("recorded");
    await fetch(login.headers.get("location")!);
    release();
    await s.settle();
    expect(s.record().keep_approval).toMatchObject({ outcome: "recorded", document_id: s.world.main, version_number: 4 });
    expect(s.record().approval).toEqual({ document_id: s.world.main, version_number: 4 });
  });

  test("a record replaced while the sign-in waits (Share as new) never takes the old space's approval outcome", async () => {
    const pages: string[] = [];
    const s = setup({
      jobs: {
        // The browser is left on the sign-in page; the test presses Allow itself, later.
        openBrowser: async (url) => {
          pages.push(url);
          return "opened";
        },
      },
    });
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    const first = s.record().space_id;
    expect(await s.jobs.keep(id)).toMatchObject({ keep: "waiting" });
    s.jobs.share(id, { fresh: true });
    await s.jobs.running(id);
    expect(s.record().space_id).not.toBe(first);
    // Allow on the old page: the old space records the approval; the new record must not say so.
    const login = await s.spaces.fetch(pages[0]!, { redirect: "manual" });
    expect(new URL(login.headers.get("location")!).searchParams.get("approval")).toBe("recorded");
    await fetch(login.headers.get("location")!);
    await s.settle();
    expect(s.record().space_id).not.toBe(first);
    expect(s.record().keep_approval).toBeUndefined();
    expect(s.record().approval).toBeNull();
  });

  test("someone else kept it between the page and the press: the claim on the page is lost, no token comes, and the panel is told", async () => {
    const holder: { s: ReturnType<typeof setup> | null } = { s: null };
    const s = setup({
      spaces: { login: "page" },
      jobs: {
        // The page is drawn while the space is free; someone else keeps it; then Allow is pressed.
        openBrowser: async (url) => {
          const t = holder.s!;
          t.opened.push(url);
          const page = await (await t.spaces.fetch(url)).text();
          t.spaces.keptBy(t.record().space_id, "Someone Else");
          const press = await t.spaces.fetch(`${HOST}${/href="(\/cli\/login\/allow[^"]+)"/.exec(page)![1]}`, { redirect: "manual" });
          await fetch(press.headers.get("location")!);
          return "opened";
        },
      },
    });
    holder.s = s;
    s.jobs.share(s.world.plan, {});
    await s.settle();
    await s.jobs.keep(s.world.plan);
    await s.settle();
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "refused", kept: false, signed_in: false, keep: null });
    expect(s.record().refused).toBe(true);
    expect(s.spaces.exchanges).toHaveLength(0);
    expect(s.spaces.spaces.get(s.record().space_id)!.owner).toBe("Someone Else");
  });

  test("someone else owned it when the page was drawn: a sign-in only; our own claim gets 409, and the space is never shown as kept", async () => {
    const s = setup();
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    s.spaces.keptBy(s.record().space_id, "Someone Else");
    await s.jobs.keep(id);
    await s.settle();
    // The page signed in only (a code, no claim); the claim that says whose it is was ours, and it lost.
    const claims = s.spaces.calls.filter((c) => c.method === "POST" && c.path.endsWith("/claim"));
    expect(claims.map((c) => [c.signedIn, c.status, c.code])).toEqual([[true, 409, "claim_conflict"]]);
    expect(s.jobs.status(id)).toMatchObject({ phase: "refused", kept: false, signed_in: true, keep: null });
    expect([s.record().kept, s.record().refused, s.record().approval]).toEqual([false, true, null]);
    // The approval was asked (the plan is approved and the space held v4); the page answered none, and that is kept.
    expect(new URL(s.opened[0]!).searchParams.get("approve_document")).not.toBeNull();
    expect(s.record().keep_approval).toMatchObject({ outcome: "none", version_number: 4 });
    expect(s.spaces.spaces.get(s.record().space_id)!.owner).toBe("Someone Else");
    expect(s.spaces.spaces.get(s.record().space_id)!.approvals).toEqual([]);
  });

  test("a sign-in given up changes nothing; from a remote window there is no browser to come back", async () => {
    const s = setup({ jobs: { openBrowser: async () => "opened" } });
    s.jobs.share(s.world.plan, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    await s.jobs.running(s.world.plan);
    expect(await s.jobs.keep(s.world.plan)).toMatchObject({ keep: "waiting" });
    expect(s.jobs.keepCancel(s.world.plan)).toMatchObject({ keep: null, phase: "shared", kept: false, signed_in: false });
    expect(existsSync(spacesCredentialPath(s.dataDir))).toBe(false);
    const remote = setup({ jobs: { remote: () => true } });
    expect(await remote.jobs.keep(remote.world.plan)).toMatchObject({ keep: "remote" });
    expect(remote.opened).toEqual([]);
  });

  test("signed in before the first share: the space is made as the person's own; a refused token is forgotten", async () => {
    const s = setup();
    const token = s.spaces.issueToken("Maya Chen");
    saveSpacesCredential(s.dataDir, HOST, { token, name: "Maya Chen" });
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "none", signed_in: true, who: "Maya Chen", access: "private" });
    s.jobs.share(s.world.plan, {});
    await s.settle();
    expect(s.spaces.spaces.get(s.record().space_id)!.owner).toBe("Maya Chen");
    // Signed in: the plan's id is the space's key.
    expect(s.spaces.spaces.get(s.record().space_id)!.external_key).toBe(s.world.plan);
    // Made signed in: the space itself says private, and only then is it "only you".
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "shared", kept: true, access: "private" });
    s.spaces.revoke(token);
    s.world.store.addVersion(s.world.plan, s.world.main, { bytes: enc("# v5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    s.jobs.share(s.world.plan, {});
    await s.jobs.running(s.world.plan);
    expect(readSpacesCredential(s.dataDir, HOST)).toBeNull();
    // Signed out: the result panel with Keep, which signs in. No Update is offered that could only fail, an Update
    // pressed anyway sends nothing, and no browser is ever opened by it.
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "shared", signed_in: false, kept: false, needs_keep: true, own: true, changes: 1, keep: null, access: "private" });
    const calls = s.spaces.calls.length;
    expect(s.jobs.share(s.world.plan, {})).toMatchObject({ phase: "shared", keep: null });
    await s.settle();
    expect([s.spaces.calls.length, s.opened]).toEqual([calls, []]);
    // Keep signs in again; the space was the person's own all along, and what waited goes up.
    await s.jobs.keep(s.world.plan);
    await s.settle();
    expect(s.opened).toHaveLength(1);
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "shared", signed_in: true, kept: true, changes: 0 });
    expect(s.spaces.spaces.size).toBe(1);
  });

  test("signed in, Share as new makes a new space each time under a key of its own, even once the record is gone; a plain Share keeps the plan's id", async () => {
    const s = setup({ seed: { extras: false } });
    const id = s.world.plan;
    saveSpacesCredential(s.dataDir, HOST, { token: s.spaces.issueToken("Maya Chen"), name: "Maya Chen" });
    const made: string[] = [];
    for (const fresh of [false, true, true]) {
      s.jobs.share(id, { fresh });
      await s.settle();
      made.push(s.record().space_id);
    }
    // Stop sharing deletes the last space and forgets the record; Share as new after it is still a space of its own.
    expect((await s.jobs.remove(id)).ok).toBe(true);
    s.jobs.share(id, { fresh: true });
    await s.settle();
    made.push(s.record().space_id);
    expect(new Set(made).size).toBe(4);
    const keys = made.map((ws) => s.spaces.spaces.get(ws)!.external_key);
    expect(keys).toEqual([id, `${id}:${made[1]!.slice(3)}`, `${id}:${made[2]!.slice(3)}`, `${id}:${made[3]!.slice(3)}`]);
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", kept: true });
  });

  test("one claim at a time: a second Keep joins the first, and an Update pressed meanwhile neither starts nor undoes it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = setup();
    s.jobs.share(s.world.plan, {});
    await s.settle();
    saveSpacesCredential(s.dataDir, HOST, { token: s.spaces.issueToken("Maya Chen"), name: "Maya Chen" });
    // The claim's answer is held back.
    const held = createSpaceShareJobs({ dataDir: s.dataDir, store: () => s.world.store, host: () => HOST, remote: () => false, openBrowser: async () => "opened", fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/claim")) await gate;
      return s.spaces.fetch(input, init);
    }) as typeof fetch });
    closers.push(() => held.close());
    const first = held.keep(s.world.plan);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(held.status(s.world.plan)).toMatchObject({ busy: true, kept: false });
    const second = held.keep(s.world.plan);
    s.world.store.addVersion(s.world.plan, s.world.main, { bytes: enc("# v5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    expect(held.share(s.world.plan, {})).toMatchObject({ phase: "shared", busy: true });
    expect(held.running(s.world.plan)).toBeNull();
    release();
    await Promise.all([first, second]);
    await held.running(s.world.plan);
    expect(s.spaces.calls.filter((c) => c.path.endsWith("/claim"))).toHaveLength(1);
    expect(readSpaceShareRecord(s.dataDir, s.world.plan)!.kept).toBe(true);
    expect(held.status(s.world.plan)).toMatchObject({ phase: "shared", kept: true, busy: false, changes: 0 });
  });

  test("a claim that gets a 401: the token is forgotten and nothing is called someone else's; a 404 changes nothing", async () => {
    const s = setup();
    s.jobs.share(s.world.plan, {});
    await s.settle();
    saveSpacesCredential(s.dataDir, HOST, { token: "wscli_live_revoked", name: "Maya Chen" });
    await s.jobs.keep(s.world.plan);
    expect(readSpacesCredential(s.dataDir, HOST)).toBeNull();
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "shared", kept: false, signed_in: false });
    saveSpacesCredential(s.dataDir, HOST, { token: s.spaces.issueToken("Maya Chen"), name: "Maya Chen" });
    s.spaces.failNext(/claim$/, 404, "workspace_not_found");
    await s.jobs.keep(s.world.plan);
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "shared", kept: false, signed_in: true });
  });

  test("going down: the sign-in's listener is closed and a run is stopped", async () => {
    let login = "";
    const s = setup({ jobs: { openBrowser: async (url) => ((login = url), "opened") } });
    s.jobs.share(s.world.plan, {});
    await s.settle();
    await s.jobs.keep(s.world.plan);
    expect(s.jobs.status(s.world.plan)).toMatchObject({ keep: "waiting" });
    const back = new URL(login).searchParams.get("redirect_uri")!;
    expect((await fetch(back)).status).toBe(404);
    s.jobs.close();
    expect(s.jobs.status(s.world.plan)).toMatchObject({ keep: null });
    expect(await fetch(back).then(() => "answered", () => "closed")).toBe("closed");
  });
});

describe("Sign in while a run waits", () => {
  test("a busy space, then Sign in: the waiting run is stopped and goes on signed in, as one space of the person's own", async () => {
    const s = setup({ jobs: { sleep: (_ms, signal) => new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })) } });
    s.spaces.failNext(/^POST \/v1\/workspaces$/, 429, "rate_limited");
    s.jobs.share(s.world.plan, { mode: "newest" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "sharing", link: null, progress: { done: 0 } });
    expect(s.jobs.status(s.world.plan)!.waiting).toBeGreaterThan(0);
    await s.jobs.keep(s.world.plan);
    await s.settle();
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "shared", kept: true, signed_in: true });
    expect(s.spaces.spaces.size).toBe(1);
    expect(s.spaces.spaces.get(s.record().space_id)!.owner).toBe("Maya Chen");
  });
});

describe("Stop sharing", () => {
  test("deletes a kept space and forgets the share; a space nobody kept is never deleted", async () => {
    const s = setup();
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    expect((await s.jobs.remove(id)).ok).toBe(false);
    expect(s.spaces.calls.some((c) => c.method === "DELETE")).toBe(false);
    await s.jobs.keep(id);
    await s.settle();
    const space = s.spaces.spaces.get(s.record().space_id)!;
    s.spaces.failNext(/^DELETE/, 500, "internal_error");
    expect((await s.jobs.remove(id)).ok).toBe(false);
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared" });
    expect((await s.jobs.remove(id)).ok).toBe(true);
    expect(space.deleted).toBe(true);
    expect(s.jobs.status(id)).toMatchObject({ phase: "none", link: null });
  });
});

describe("the routes", () => {
  test("GET the status, POST a share with its mode, refuse what is not one", async () => {
    const s = setup();
    const id = s.world.plan;
    const call = (method: string, tail: string[], body: unknown = {}) => handleSpaceShareRoute({ method, parts: [id, "share", ...tail], json: async () => body }, s.jobs);
    expect(await handleSpaceShareRoute({ method: "GET", parts: [id, "versions"], json: async () => ({}) }, s.jobs)).toBeNull();
    expect(await call("GET", [])).toMatchObject({ status: 200, body: { phase: "none" } });
    expect(await call("POST", [], { mode: "sideways" })).toMatchObject({ status: 400 });
    expect(await call("POST", [], { host: "https://elsewhere.example" })).toMatchObject({ status: 400 });
    expect(await call("POST", [], { mode: "newest", serverSession: "x" })).toMatchObject({ status: 200, body: { phase: "sharing" } });
    await s.settle();
    expect(s.record().mode).toBe("newest");
    expect(await call("POST", ["nope"])).toMatchObject({ status: 404 });
    expect(await call("POST", ["delete"])).toMatchObject({ status: 502 });
    expect(await handleSpaceShareRoute({ method: "GET", parts: ["pln_01HZZZZZZZZZZZZZZZZZZZZZZ9", "share"], json: async () => ({}) }, s.jobs)).toMatchObject({ status: 404 });
  });
});

describe("where it goes, and whether it may", () => {
  test("https, or http on this computer only; the env var over config.json; a bad value never used", () => {
    expect(normalizeSpacesUrl("https://spaces.example/path?x=1")).toBe("https://spaces.example");
    expect(normalizeSpacesUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeSpacesUrl("http://spaces.example")).toBeNull();
    expect(normalizeSpacesUrl("ftp://x")).toBeNull();
    expect(resolveSpacesUrl({}, {})).toBe(DEFAULT_SPACES_URL);
    expect(new URL(DEFAULT_SPACES_URL).hostname.endsWith(".invalid")).toBe(true);
    expect(resolveSpacesUrl({ spacesUrl: "https://a.example" }, {})).toBe("https://a.example");
    expect(resolveSpacesUrl({ spacesUrl: "https://a.example" }, { PLANNOTATOR_SPACES_URL: "http://localhost:9" })).toBe("http://localhost:9");
    expect(resolveSpacesUrl({ spacesUrl: "https://a.example" }, { PLANNOTATOR_SPACES_URL: "http://b.example" })).toBe("https://a.example");
    expect(isLoopbackSpacesUrl("http://127.0.0.1:9")).toBe(true);
    expect(isLoopbackSpacesUrl("https://spaces.example")).toBe(false);
  });

  test("off unless config.json says so, and off with every other share", () => {
    expect(spaceShareOn({}, {})).toBe(false);
    expect(spaceShareOn({ inboxSpaceShare: true }, {})).toBe(true);
    expect(spaceShareOn({ inboxSpaceShare: true }, { PLANNOTATOR_SHARE: "disabled" })).toBe(false);
    expect(spaceShareOn({ inboxSpaceShare: true, share: "disabled" }, {})).toBe(false);
  });
});
