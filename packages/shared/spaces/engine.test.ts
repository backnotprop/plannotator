/**
 * The share engine against a stand-in for the Spaces REST surface (tests/helpers/fake-spaces.ts; no socket, no
 * host). What regresses if these fail:
 * - a share puts the wrong things up: versions out of order, a comment the agent already has, a "Changes asked"
 *   note, a picture or a table as a page, a comment without its `anno_` id as the idempotency key, a reply as a
 *   second comment;
 * - a call tried twice makes two things (a second space, page, version or comment), or a run that stopped starts over;
 * - a 429 is not waited out for as long as the space said, or the count goes backwards;
 * - an Update sends what is already up, writes over a page someone changed in the space, or goes on writing to a
 *   space someone else kept;
 * - the approval goes before the pages, into a space nobody kept, or its refusal fails the share.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitBlobSha } from "@plannotator/core/plans";
import { newSpaceId, newSpaceShareRecord, type SpaceShareMode, type SpaceShareRecord } from "@plannotator/core/space-share";
import { createFakeSpaces, type FakeSpaces } from "../../../tests/helpers/fake-spaces";
import { seedSpaceShareWorld, type SpaceShareWorld } from "../../../tests/helpers/space-share-world";
import { createSpacesClient } from "./client";
import { runSpaceShare, type SpaceShareProgress } from "./engine";
import { spaceShareSource } from "./share-job";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HOST = "http://127.0.0.1:1";
const enc = (text: string) => new TextEncoder().encode(text);

function setup(options: { mode?: SpaceShareMode; token?: boolean; seed?: Parameters<typeof seedSpaceShareWorld>[1]; spaces?: Parameters<typeof createFakeSpaces>[0] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "space-share-"));
  dirs.push(dataDir);
  const world = seedSpaceShareWorld(dataDir, options.seed);
  const spaces = createFakeSpaces({ origin: HOST, ...options.spaces });
  const token = options.token ? spaces.issueToken("Maya Chen") : null;
  const record = newSpaceShareRecord({ host: HOST, space_id: newSpaceId(), name: "Rate limiting for public endpoints", mode: options.mode ?? "all", kept: !!token, at: new Date().toISOString() });
  const saved: SpaceShareRecord[] = [];
  const progress: SpaceShareProgress[] = [];
  const waits: number[] = [];
  const run = (signal?: AbortSignal) =>
    runSpaceShare({
      source: spaceShareSource(world.store, world.plan)!,
      record,
      save: (r) => saved.push(JSON.parse(JSON.stringify(r))),
      client: createSpacesClient({ host: HOST, token, fetch: spaces.fetch, signal }),
      signal,
      progress: (p) => progress.push({ ...p }),
      sleep: async (ms) => {
        waits.push(ms);
        spaces.resetWrites();
      },
      newSpaceId,
    });
  return { world, spaces, record, saved, progress, waits, run, token };
}

const writes = (spaces: FakeSpaces) => spaces.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path.replace(/(ws|doc|anno|asset)_[0-9A-Z]{26}/g, "$1")}`);
const spaceOf = (spaces: FakeSpaces, record: SpaceShareRecord) => spaces.spaces.get(record.space_id)!;
const mainOf = (s: ReturnType<typeof setup>) => spaceOf(s.spaces, s.record).documents.find((d) => d.id === s.record.pages[s.world.main]!.remote_id)!;

describe("what goes up", () => {
  test("all versions: the space with v1, then each version oldest first on top of the one before, pages, files, the unsent comment", async () => {
    const s = setup();
    expect((await s.run()).end).toBe("done");
    const main = mainOf(s);
    expect(main.versions.map((v) => v.version)).toEqual(s.world.store.versions(s.world.plan, s.world.main).map((v) => v.version));
    // Each save named the version before it.
    const saves = s.spaces.calls.filter((c) => c.method === "PUT" && c.path.includes(`/documents/${main.id}`));
    expect(saves.map((c) => c.ifMatch)).toEqual(main.versions.slice(0, 3).map((v) => `"${v.version}"`));
    // The record: the hosted page and each pushed pair.
    expect(s.record.pages[s.world.main]!.pushed.map((p) => [p.local, p.remote])).toEqual(main.versions.map((v, i) => [i + 1, v.version]));
    expect(s.record.share_url).toBe(spaceOf(s.spaces, s.record).share_url);
    const space = spaceOf(s.spaces, s.record);
    expect(space.documents.map((d) => `${d.kind}:${d.doc_path}`).sort()).toEqual(["html:dashboard-mockup.html", "markdown:Load test notes.md", "markdown:Rate limiting for public endpoints.md", "markdown:Rollout checklist.md", "mermaid:Request flow.mmd"]);
    expect(space.assets.map((a) => a.path).sort()).toEqual(["architecture.png", "load-test-chart.png"]);
    // Only the comment the agent does not have, under its `anno_` id, without its pictures; never a decision's notes.
    expect(space.comments.map((c) => c.body)).toEqual(["Should the Free tier burst be lower?"]);
    expect(space.comments[0]!.key).toBe(s.world.unsent);
    expect(space.comments[0]!.document_version).toBe(main.versions[3]!.version);
    expect((space.comments[0]!.anchor as { id: string; images?: unknown }).id).toBe("open-1");
    expect((space.comments[0]!.anchor as { images?: unknown }).images).toBeUndefined();
    expect(JSON.stringify([...s.spaces.spaces.values()])).not.toContain(s.world.changesAsked);
    expect(s.spaces.calls.some((c) => c.path.endsWith("/approval"))).toBe(false);
    // The count never goes back and ends whole.
    expect(s.progress.every((p, i) => i === 0 || p.done >= s.progress[i - 1]!.done)).toBe(true);
    const last = s.progress[s.progress.length - 1]!;
    expect([last.done, last.total]).toEqual([12, 12]);
    expect(s.record.job).toBeNull();
  });

  test("newest: one version of each page", async () => {
    const s = setup({ mode: "newest" });
    expect((await s.run()).end).toBe("done");
    expect(mainOf(s).versions.map((v) => v.version)).toEqual([s.world.store.versions(s.world.plan, s.world.main)[3]!.version]);
    expect(s.record.pages[s.world.pages.rollout]!.pushed.map((p) => p.local)).toEqual([2]);
    expect(spaceOf(s.spaces, s.record).comments).toHaveLength(1);
  });

  test("a picture page and a table page go up as files; a reply goes through the reply call", async () => {
    const s = setup({ seed: { extras: false, versions: 1, approve: false } });
    const { store, plan, main } = s.world;
    const picture = store.addDocument(plan, { title: "Chart", kind: "image", created_at: new Date().toISOString() });
    store.addVersion(plan, picture.id, { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), committed_at: new Date().toISOString(), source: "agent-tool" });
    const table = store.addDocument(plan, { title: "Numbers", kind: "data", created_at: new Date().toISOString() });
    store.addVersion(plan, table.id, { bytes: enc("a,b\n1,2\n"), committed_at: new Date().toISOString(), source: "agent-tool" });
    const head = store.versions(plan, main)[0]!;
    const reply = store.saveComment(plan, { document_id: main, document_version: head.version, annotation: { id: "reply-1", type: "COMMENT", text: "Yes: 90.", inReplyTo: "open-1" }, at: new Date().toISOString() });
    expect((await s.run()).end).toBe("done");
    const space = spaceOf(s.spaces, s.record);
    expect(space.documents).toHaveLength(1);
    expect(space.assets.map((a) => `${a.path} ${a.content_type}`).sort()).toEqual(["Chart.png image/png", "Numbers.csv text/csv; charset=utf-8"]);
    expect(s.record.pages[picture.id]!.lane).toBe("file");
    expect(space.comments).toHaveLength(1);
    expect(space.comments[0]!.replies.map((r) => [r.body, r.key])).toEqual([["Yes: 90.", reply.id]]);
  });
});

describe("a call tried twice is one thing", () => {
  test("the create's answer is lost: the same call again, one space", async () => {
    const s = setup();
    s.spaces.failNext(/^POST \/v1\/workspaces$/, 0, "lost", { after: true });
    const first = await s.run();
    expect(first.end).toBe("failed");
    expect(s.spaces.spaces.size).toBe(1);
    expect(s.record.created).toBe(false);
    expect((await s.run()).end).toBe("done");
    expect(s.spaces.spaces.size).toBe(1);
    expect(mainOf(s).versions).toHaveLength(4);
  });

  test("a new version came between the tries: the create is still the call first made, and the new version follows", async () => {
    const s = setup({ mode: "newest", seed: { extras: false } });
    s.spaces.failNext(/^POST \/v1\/workspaces$/, 0, "lost", { after: true });
    expect((await s.run()).end).toBe("failed");
    s.world.store.addVersion(s.world.plan, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    const again = spaceShareSource(s.world.store, s.world.plan)!;
    expect((await runSpaceShare({ source: again, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }), newSpaceId })).end).toBe("done");
    expect(s.spaces.spaces.size).toBe(1);
    expect(mainOf(s).versions.map((v) => v.body.includes("v5"))).toEqual([false, true]);
  });

  test("a page add, a save and a comment whose answers were lost are not made twice", async () => {
    const s = setup();
    s.spaces.failNext(/^POST .*\/documents$/, 0, "lost", { after: true });
    s.spaces.failNext(/^PUT .*\/documents\//, 0, "lost", { after: true });
    s.spaces.failNext(/annotations$/, 0, "lost", { after: true });
    let end = (await s.run()).end;
    for (let i = 0; i < 4 && end !== "done"; i++) end = (await s.run()).end;
    expect(end).toBe("done");
    const space = spaceOf(s.spaces, s.record);
    expect(space.documents).toHaveLength(5);
    expect(mainOf(s).versions).toHaveLength(4);
    expect(space.comments).toHaveLength(1);
    expect(s.record.pages[s.world.main]!.stopped).toBeNull();
  });
});

describe("a run that stopped goes on", () => {
  test("after a failure the next run sends only what is left, and the count goes on", async () => {
    const s = setup();
    s.spaces.failNext(/assets\/architecture\.png$/, 503, "unavailable", { times: 1 });
    const first = await s.run();
    expect(first.end).toBe("failed");
    const done = s.record.job!.done;
    expect(done).toBeGreaterThan(0);
    expect(s.record.job).toEqual({ done, total: 12, ended: "failed" });
    const before = writes(s.spaces).length;
    expect((await s.run()).end).toBe("done");
    // Nothing sent before was sent again.
    expect(writes(s.spaces).length - before).toBe(12 - done);
    const resumed = s.progress.filter((p) => p.done > done);
    expect(resumed[0]).toMatchObject({ done: done + 1, total: 12 });
    expect(spaceOf(s.spaces, s.record).documents).toHaveLength(5);
  });

  test("Stop ends it; what is up stays up and nothing is sent twice", async () => {
    const s = setup();
    const abort = new AbortController();
    let seen = 0;
    const original = s.spaces.fetch;
    const client = createSpacesClient({
      host: HOST,
      signal: abort.signal,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await original(input, init);
        if (++seen === 3) abort.abort();
        return response;
      }) as typeof fetch,
    });
    const stopped = await runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client, signal: abort.signal, newSpaceId });
    expect(stopped.end).toBe("stopped");
    expect(s.record.job).toMatchObject({ done: 3, ended: "stopped" });
    expect((await s.run()).end).toBe("done");
    expect(writes(s.spaces)).toHaveLength(12);
  });
});

describe("waiting when the space says so", () => {
  test("a 429 is waited out for its Retry-After, said in the progress, and the share finishes", async () => {
    const s = setup({ spaces: { openWrites: 5, retryAfter: 7 } });
    expect((await s.run()).end).toBe("done");
    expect(s.waits.length).toBeGreaterThanOrEqual(2);
    expect(s.waits.every((ms) => ms > 6000 && ms <= 7000)).toBe(true);
    const waiting = s.progress.filter((p) => p.waiting_until !== null);
    expect(waiting.length).toBe(s.waits.length);
    expect(waiting[0]!.done).toBe(5);
    expect(s.spaces.calls.filter((c) => c.status === 429)).toHaveLength(s.waits.length);
    expect(spaceOf(s.spaces, s.record).documents).toHaveLength(5);
    expect(mainOf(s).versions).toHaveLength(4);
  });
});

describe("Update", () => {
  test("nothing changed: nothing is sent; a new version: one save", async () => {
    const s = setup();
    await s.run();
    const before = s.spaces.calls.length;
    expect((await s.run()).end).toBe("done");
    expect(s.spaces.calls.length).toBe(before);
    s.world.store.addVersion(s.world.plan, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    const next = spaceShareSource(s.world.store, s.world.plan)!;
    expect((await runSpaceShare({ source: next, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }), newSpaceId })).end).toBe("done");
    expect(writes(s.spaces).slice(12)).toEqual(["PUT /v1/workspaces/ws/documents/doc"]);
    expect(mainOf(s).versions).toHaveLength(5);
  });

  test("a page that changed in the space is left alone and marked; the rest goes up", async () => {
    const s = setup();
    await s.run();
    const space = spaceOf(s.spaces, s.record);
    s.spaces.editPage(space.id, "Rollout checklist.md", "# Rollout checklist\n\nEdited in the space.\n");
    const { store, plan, main, pages } = s.world;
    store.addVersion(plan, pages.rollout, { bytes: enc("# Rollout checklist\n\nv3 here\n"), committed_at: new Date().toISOString(), source: "agent-tool" });
    store.addVersion(plan, main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    const run = () => runSpaceShare({ source: spaceShareSource(store, plan)!, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }), newSpaceId });
    expect((await run()).end).toBe("done");
    const rollout = space.documents.find((d) => d.doc_path === "Rollout checklist.md")!;
    expect(rollout.versions[rollout.versions.length - 1]!.body).toContain("Edited in the space.");
    expect(s.record.pages[pages.rollout]!.stopped).toEqual({ current: gitBlobSha("# Rollout checklist\n\nEdited in the space.\n") });
    expect(mainOf(s).versions).toHaveLength(5);
    // Left alone from then on.
    const before = s.spaces.calls.length;
    expect((await run()).end).toBe("done");
    expect(s.spaces.calls.length).toBe(before);
  });

  for (const refusal of [401, 403, 404] as const) {
    test(`someone else kept the space (${refusal}): refused, and nothing more is sent`, async () => {
      const s = setup({ spaces: { refusal } });
      await s.run();
      s.spaces.keptBy(s.record.space_id, "Someone Else");
      s.world.store.addVersion(s.world.plan, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
      const run = () => runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }), newSpaceId });
      expect((await run()).end).toBe("refused");
      expect(s.record.refused).toBe(true);
      expect(mainOf(s).versions).toHaveLength(4);
      const before = s.spaces.calls.length;
      expect((await run()).end).toBe("refused");
      expect(s.spaces.calls.length).toBe(before);
    });
  }

  test("more files than a space nobody kept may hold: over the limit, with what is up kept", async () => {
    const s = setup({ spaces: { openQuota: 80 } });
    expect((await s.run()).end).toBe("over_limit");
    expect(s.record.job!.ended).toBe("over_limit");
    expect(s.record.share_url).not.toBeNull();
  });
});

describe("the approval", () => {
  test("goes last, and only into a kept space", async () => {
    const s = setup({ token: true, spaces: { approvals: "accept" } });
    expect((await s.run()).end).toBe("done");
    const all = writes(s.spaces);
    expect(all[all.length - 1]).toBe("PUT /v1/workspaces/ws/documents/doc/approval");
    expect(all.filter((w) => w.endsWith("/approval"))).toHaveLength(1);
    const space = spaceOf(s.spaces, s.record);
    expect(space.owner).toBe("Maya Chen");
    expect(space.approvals).toEqual([{ document_id: s.record.pages[s.world.main]!.remote_id!, version: mainOf(s).versions[3]!.version, by: "Maya Chen" }]);
    expect(s.record.approval).toEqual({ document_id: s.world.main, version_number: 4 });
    // Every call carried the sign-in in its header, and none in its address.
    expect(s.spaces.calls.every((c) => c.signedIn && !`${c.path}${c.query}`.includes(s.token!))).toBe(true);
  });

  test("a space that does not take it: the share is done without it, and it is not asked again", async () => {
    const s = setup({ token: true });
    expect((await s.run()).end).toBe("done");
    expect(s.record.approval).toBeNull();
    expect(s.record.approval_refused).toBe(true);
    const before = s.spaces.calls.length;
    expect((await s.run()).end).toBe("done");
    expect(s.spaces.calls.length).toBe(before);
  });
});
