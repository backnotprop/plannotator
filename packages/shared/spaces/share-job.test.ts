/**
 * Share this space as the Inbox runs it: the job per plan, its routes, the sign-in and the credential file, against
 * the stand-in (tests/helpers/fake-spaces.ts; the only socket is the sign-in's own listener on 127.0.0.1). What
 * regresses if these fail:
 * - the status says the wrong thing (a link before there is one, "shared" while a run is going, changes after
 *   nothing changed), or carries the sign-in token to the page;
 * - Keep does not make the space the person's own, loses the race quietly, or sends the approval before the claim;
 * - the token lands in a file others can read, in a URL, or stays after the space refused it;
 * - Stop sharing forgets a space that was not deleted, or deletes one nobody kept;
 * - the address resolver takes plain http to another machine, or the switch is on by default.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeSpaces } from "../../../tests/helpers/fake-spaces";
import { seedSpaceShareWorld } from "../../../tests/helpers/space-share-world";
import { readSpacesCredential, saveSpacesCredential, spacesCredentialPath } from "./credential";
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
    expect(s.jobs.status(id)).toMatchObject({ phase: "shared", stopped_pages: [{ title: "Rollout checklist", url: `${link}/Rollout%20checklist.md` }], changes: 0 });
    s.spaces.keptBy(first, "Someone Else");
    s.world.store.addVersion(id, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    s.jobs.share(id, {});
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

describe("Keep this space", () => {
  test("signs in through the browser, keeps the token in a 0600 file, claims the space, then sends the approval", async () => {
    const s = setup({ spaces: { approvals: "accept" } });
    const id = s.world.plan;
    s.jobs.share(id, {});
    await s.settle();
    expect(s.spaces.calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
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
    // The claim first, the approval after it and last.
    const order = s.spaces.calls.map((c) => c.path.split("/").pop());
    expect(order.indexOf("claim")).toBeGreaterThan(-1);
    expect(order.lastIndexOf("approval")).toBe(order.length - 1);
    expect(space.approvals).toHaveLength(1);
  });

  test("someone else kept it first: the claim is refused and the panel is told", async () => {
    const s = setup();
    s.jobs.share(s.world.plan, {});
    await s.settle();
    s.spaces.keptBy(s.record().space_id, "Someone Else");
    await s.jobs.keep(s.world.plan);
    await s.settle();
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "refused", kept: false, signed_in: true });
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
    // Made signed in: the space itself says private, and only then is it "only you".
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "shared", kept: true, access: "private" });
    s.spaces.revoke(token);
    s.world.store.addVersion(s.world.plan, s.world.main, { bytes: enc("# v5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    s.jobs.share(s.world.plan, {});
    await s.jobs.running(s.world.plan);
    expect(readSpacesCredential(s.dataDir, HOST)).toBeNull();
    // Signed out: the result panel with Keep, which signs in. No Update is offered that could only fail, an Update
    // pressed anyway sends nothing, and no browser is ever opened by it.
    expect(s.jobs.status(s.world.plan)).toMatchObject({ phase: "shared", signed_in: false, kept: false, changes: 0, keep: null });
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
