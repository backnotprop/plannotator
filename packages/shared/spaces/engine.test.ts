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
import { newSpaceId, newSpaceShareRecord, planSpaceShare, spaceCommentAnchor, type SpaceShareMode, type SpaceShareRecord } from "@plannotator/core/space-share";
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
  const record = newSpaceShareRecord({ host: HOST, space_id: newSpaceId(), name: "Rate limiting for public endpoints", mode: options.mode ?? "all", kept: false, at: new Date().toISOString() });
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
    const saves = s.spaces.calls.filter((c) => c.method === "PATCH" && c.path.includes(`/documents/${main.id}`));
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
    // Where it sits and what it says only (its id too, so this side finds it again): no pictures or time.
    expect(Object.keys(space.comments[0]!.anchor as object).sort()).toEqual(["blockId", "endOffset", "id", "originalText", "startOffset", "text", "type"]);
    expect((space.comments[0]!.anchor as { id: string }).id).toBe("open-1");
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

describe("the imported shape: every version and comment says it was put up at this run's time, and nothing more", () => {
  const SHARED_AT = "2026-11-20T10:00:00.000Z";
  const runAt = (s: ReturnType<typeof setup>, at: string, token: string | null = s.token) =>
    runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, token, fetch: s.spaces.fetch }), now: () => Date.parse(at) });
  /** Every JSON body sent, by the kind of call. */
  const sent = (spaces: FakeSpaces) => {
    const of = (test: (c: FakeSpaces["calls"][number]) => boolean) => spaces.calls.filter((c) => c.method !== "GET" && test(c));
    return {
      create: of((c) => c.method === "POST" && c.path === "/v1/workspaces"),
      saves: of((c) => c.method === "PATCH" && /\/documents\/[^/]+$/.test(c.path)),
      rawSaves: of((c) => c.method === "PUT" && /\/documents\/[^/]+$/.test(c.path)),
      adds: of((c) => c.method === "POST" && /\/documents$/.test(c.path)),
      comments: of((c) => c.method === "POST" && c.path.endsWith("/annotations")),
      replies: of((c) => c.method === "POST" && c.path.endsWith("/replies")),
      files: of((c) => c.method === "PUT" && c.path.includes("/assets/")),
    };
  };

  test("the create, every page add and save, every comment and reply carry one actor with one share time; files (and a file that goes as a page) none; no author, agent or original time anywhere", async () => {
    const s = setup({ seed: { extras: true } });
    const { store, plan, main, unsent } = s.world;
    // A version and a comment that do know who and when: none of it goes.
    store.addVersion(plan, main, { bytes: enc("# Rate limiting\n\nv5 by an agent\n"), committed_at: "2026-11-12T08:30:00.000Z", source: "agent-tool", author_label: "Maya Chen", agent_host: "claude-code", agent_session: "sess-secret-1", agent_name: "Claude" });
    const head = store.versions(plan, main).slice(-1)[0]!;
    const comment = store.saveComment(plan, { document_id: main, document_version: head.version, annotation: { id: "open-2", type: "COMMENT", text: "Is 90 enough?" }, at: "2026-11-12T08:31:00.000Z" });
    store.saveComment(plan, { document_id: main, document_version: head.version, annotation: { id: "reply-2", type: "COMMENT", text: "Yes.", inReplyTo: "open-2" }, at: "2026-11-12T08:32:00.000Z" });
    // A comment carrying everything an anchor may hold that is not where it sits: none of it goes.
    const leaky = store.saveComment(plan, {
      document_id: main,
      document_version: head.version,
      annotation: {
        id: "leaky-anchor-id",
        type: "COMMENT",
        text: "See the picture.",
        originalText: "The public API",
        blockId: "block-2",
        startOffset: 0,
        endOffset: 3,
        source: "eslint-tool-id",
        author: "swift-otter",
        mentions: ["@maya-host-id"],
        createdA: 1,
        pageUrl: "/settings?private-page",
        prUrl: "https://github.com/acme/private-repo/pull/7",
        artifact: { artifactUrl: "https://github.com/acme/private-repo/artifact", sourceUrl: "https://github.com/acme/private-repo/src" },
        elementContext: { tag: "div", path: "body > div#secret-root", page: { url: "/private-route" } },
        htmlAdditionalTargets: [{ label: "Button", text: "more", anchor: { selector: "button", tagName: "BUTTON", extra: "target-extra-secret" }, context: { tag: "span", path: "body > span#extra-secret" } }],
        diagramAdditionalTargets: [{ family: "flowchart", kind: "edge", from: "A", to: "B", label: "Yes", url: "https://github.com/acme/private-repo/edge" }],
        mathTargets: [{ blockId: "block-3", tex: "x^2", displayMode: false, path: "/Users/someone/math-secret" }],
        diffContext: "modified",
        questionAnswer: { v: 1, key: "q1", kind: "single", prompt: "Which?", selected: ["A"], sourceLine: 4, author: "question-author-secret" },
        imageRegion: { v: 1, src: "/Users/someone/private/shot.png", sourceLine: 3, box: { x: 1, y: 2, w: 3, h: 4 }, naturalWidth: 10, naturalHeight: 10 },
        diagramAnchor: { v: 1, family: "flowchart", kind: "node", id: "A", label: "Client", sourceLine: [2, 2], extra: "diagram-extra-secret" },
        htmlAnchor: { selector: "h1", tagName: "H1", point: { x: 0.5, y: 0.5 }, extra: "html-extra-secret" },
      },
      at: "2026-11-12T08:33:00.000Z",
    });
    expect((await runAt(s, SHARED_AT)).end).toBe("done");
    const calls = sent(s.spaces);
    const actor = { kind: "imported", at: SHARED_AT };
    expect(calls.create).toHaveLength(1);
    expect((calls.create[0]!.json as Record<string, unknown>).actor).toEqual(actor);
    // Page versions after the first go as the JSON save, with the page's text and the actor only: never a path.
    expect(calls.saves.length).toBeGreaterThanOrEqual(4);
    expect(calls.rawSaves).toHaveLength(0);
    // A page's add carries it; a file here that goes up as a page (its extension is a page's) is a file, and does not.
    const isFilePage = (c: FakeSpaces["calls"][number]) => (c.json as { doc_path?: string }).doc_path === "dashboard-mockup.html";
    expect(calls.adds.filter((c) => !isFilePage(c)).length).toBeGreaterThan(0);
    for (const call of [...calls.adds.filter((c) => !isFilePage(c)), ...calls.saves, ...calls.comments, ...calls.replies]) expect((call.json as Record<string, unknown>).actor).toEqual(actor);
    expect(calls.adds.filter(isFilePage).map((c) => (c.json as Record<string, unknown>).actor)).toEqual([undefined]);
    for (const call of calls.saves) expect(Object.keys(call.json as object).sort()).toEqual(["actor", "body"]);
    expect(calls.comments.map((c) => c.idempotencyKey).sort()).toEqual([unsent, comment.id, leaky.id].sort());
    // The leaky one kept where it sits: its id, its picture's box without the local path, every anchor's own position fields, the answer.
    const leakyAnchor = (calls.comments.find((c) => c.idempotencyKey === leaky.id)!.json as { anchor: Record<string, unknown> }).anchor;
    expect(leakyAnchor).toEqual({
      id: "leaky-anchor-id",
      type: "COMMENT",
      text: "See the picture.",
      originalText: "The public API",
      blockId: "block-2",
      startOffset: 0,
      endOffset: 3,
      imageRegion: { v: 1, sourceLine: 3, box: { x: 1, y: 2, w: 3, h: 4 }, naturalWidth: 10, naturalHeight: 10 },
      diagramAnchor: { v: 1, family: "flowchart", kind: "node", id: "A", label: "Client", sourceLine: [2, 2] },
      htmlAnchor: { selector: "h1", tagName: "H1", point: { x: 0.5, y: 0.5 } },
      htmlAdditionalTargets: [{ label: "Button", text: "more", anchor: { selector: "button", tagName: "BUTTON" } }],
      diagramAdditionalTargets: [{ family: "flowchart", kind: "edge", from: "A", to: "B", label: "Yes" }],
      mathTargets: [{ blockId: "block-3", tex: "x^2", displayMode: false }],
      diffContext: "modified",
      questionAnswer: { v: 1, key: "q1", kind: "single", prompt: "Which?", selected: ["A"], sourceLine: 4 },
    });
    expect(calls.replies).toHaveLength(1);
    // A file takes no actor (its door refuses one).
    expect(calls.files.length).toBeGreaterThan(0);
    for (const call of calls.files) expect([call.json, call.query.includes("actor")]).toEqual([null, false]);
    const everything = JSON.stringify(s.spaces.calls.map((c) => c.json));
    for (const leak of ["Maya Chen", "claude-code", "sess-secret-1", "author_label", "agent_", "2026-11-12T08:3", ...store.versions(plan, main).map((v) => v.committed_at), "eslint-tool-id", "swift-otter", "@maya-host-id", "createdA", "private-page", "private-repo", "secret-root", "private-route", "extra-secret", "/Users/", "diagram-extra-secret", "html-extra-secret", "target-extra-secret", "math-secret", "question-author-secret"]) expect(everything).not.toContain(leak);
    // The stand-in reads them back as imported, with no author.
    const space = spaceOf(s.spaces, s.record);
    expect(space.documents.filter((d) => d.doc_path !== "dashboard-mockup.html").every((d) => d.versions.every((v) => v.imported?.at === SHARED_AT))).toBe(true);
    expect(space.comments.every((c) => c.imported?.at === SHARED_AT && c.replies.every((r) => r.imported?.at === SHARED_AT))).toBe(true);
  });

  test("a run that goes on later says its own time; the create sent again is the call first made, time included", async () => {
    const s = setup({ seed: { extras: false } });
    s.spaces.failNext(/^POST \/v1\/workspaces$/, 0, "lost", { after: true });
    expect((await runAt(s, "2026-11-20T10:00:00.000Z")).end).toBe("failed");
    expect((await runAt(s, "2026-11-20T11:00:00.000Z")).end).toBe("done");
    const calls = sent(s.spaces);
    expect(calls.create.map((c) => (c.json as { actor: { at: string } }).actor.at)).toEqual(["2026-11-20T10:00:00.000Z", "2026-11-20T10:00:00.000Z"]);
    // The first answer was lost; the second is the space's replay of the same call (another body would be a 409).
    expect(calls.create.map((c) => c.status)).toEqual([0, 201]);
    expect(s.spaces.spaces.size).toBe(1);
    expect(new Set(calls.saves.map((c) => (c.json as { actor: { at: string } }).actor.at))).toEqual(new Set(["2026-11-20T11:00:00.000Z"]));
  });

  test("the plan's id is the space's external_key on a signed-in create only (a key with no account is refused)", async () => {
    const open = setup({ seed: { extras: false } });
    expect((await runAt(open, SHARED_AT)).end).toBe("done");
    expect(sent(open.spaces).create[0]!.json).not.toHaveProperty("external_key");
    const mine = setup({ token: true, seed: { extras: false } });
    expect((await runAt(mine, SHARED_AT)).end).toBe("done");
    expect(mine.world.plan).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    expect((sent(mine.spaces).create[0]!.json as Record<string, unknown>).external_key).toBe(mine.world.plan);
    expect(spaceOf(mine.spaces, mine.record).external_key).toBe(mine.world.plan);
    // What the engine never does, the stand-in refuses as the service does.
    const refused = await createSpacesClient({ host: HOST, fetch: open.spaces.fetch }).createSpace({ id: newSpaceId(), name: "x", document: null, external_key: open.world.plan }).catch((e: { status: number }) => e.status);
    expect(refused).toBe(422);
  });

  test("an Update after the person kept the space carries the actor and goes up; another account's save is refused (403 forbidden: no edit in someone else's space) and stops for Keep", async () => {
    const s = setup({ seed: { extras: false } });
    expect((await runAt(s, SHARED_AT)).end).toBe("done");
    // The person keeps it (the claim Keep this space makes), then an Update with a new version and a comment.
    const token = s.spaces.issueToken("Maya Chen");
    await createSpacesClient({ host: HOST, token, fetch: s.spaces.fetch }).claim(s.record.space_id);
    s.record.kept = true;
    const { store, plan, main } = s.world;
    store.addVersion(plan, main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    const head = store.versions(plan, main).slice(-1)[0]!;
    store.saveComment(plan, { document_id: main, document_version: head.version, annotation: { id: "open-2", text: "And Team?" }, at: new Date().toISOString() });
    const before = s.spaces.calls.length;
    expect((await runAt(s, "2026-11-21T09:00:00.000Z", token)).end).toBe("done");
    const update = s.spaces.calls.slice(before).filter((c) => c.method !== "GET" && c.method !== "PUT");
    expect(update.map((c) => [c.method, c.status, (c.json as { actor?: unknown }).actor])).toEqual([
      ["PATCH", 200, { kind: "imported", at: "2026-11-21T09:00:00.000Z" }],
      ["POST", 201, { kind: "imported", at: "2026-11-21T09:00:00.000Z" }],
    ]);
    // Someone else's account sends the next one: a link holder of a kept space may not edit it.
    store.addVersion(plan, main, { bytes: enc("# Rate limiting\n\nv6\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    s.record.kept = false;
    const other = s.spaces.issueToken("Someone Else");
    expect((await runAt(s, "2026-11-21T10:00:00.000Z", other)).end).toBe("keep");
    expect(s.spaces.calls[s.spaces.calls.length - 1]).toMatchObject({ method: "PATCH", status: 403, code: "forbidden" });
    expect(s.record.job).toMatchObject({ keep: true });
  });
});

describe("the space's key", () => {
  test("a signed-in create whose key the person already has answers that space under its own id: the share takes that id for every later call and writes nothing over what is there", async () => {
    const s = setup({ token: true, seed: { extras: true } });
    expect((await s.run()).end).toBe("done");
    const first = s.record.space_id;
    const held = mainOf(s).versions.length;
    // The record here is lost; the same plan is shared again, with a new id made here and the same key.
    const again = newSpaceShareRecord({ host: HOST, space_id: newSpaceId(), name: "Rate limiting for public endpoints", mode: "all", kept: false, at: new Date().toISOString() });
    const sentId = again.space_id;
    const before = s.spaces.calls.length;
    const result = await runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: again, save: () => {}, client: createSpacesClient({ host: HOST, token: s.token, fetch: s.spaces.fetch }) });
    expect(result.end).toBe("done");
    expect([again.space_id === first, again.space_id === sentId, s.spaces.spaces.size]).toEqual([true, false, 1]);
    const later = s.spaces.calls.slice(before);
    expect(later[0]).toMatchObject({ method: "POST", path: "/v1/workspaces", status: 200 });
    // Every call after the create went to the space the key named, and none was refused as not found.
    expect(later.slice(1).every((c) => c.path.startsWith(`/v1/workspaces/${first}`))).toBe(true);
    expect(later.some((c) => c.status === 404)).toBe(false);
    // Its pages are taken as they are there: nothing older is saved on top, and the comment is the one already up.
    expect(mainOf({ ...s, record: again }).versions).toHaveLength(held);
    expect(again.pages[s.world.main]!.pushed.map((p) => p.local)).toEqual([4]);
    expect(spaceOf(s.spaces, again).comments).toHaveLength(1);
  });

  /** The record here is lost and the plan is shared again: a new id made here, the same key. */
  const shareAgain = async (s: ReturnType<typeof setup>, source = spaceShareSource(s.world.store, s.world.plan)!) => {
    const again = newSpaceShareRecord({ host: HOST, space_id: newSpaceId(), name: "Rate limiting for public endpoints", mode: "all", kept: false, at: new Date().toISOString() });
    const before = s.spaces.calls.length;
    const result = await runSpaceShare({ source, record: again, save: () => {}, client: createSpacesClient({ host: HOST, token: s.token, fetch: s.spaces.fetch }) });
    return { again, result, later: s.spaces.calls.slice(before) };
  };
  const renamed = (s: ReturnType<typeof setup>) => {
    // The main page's path is worked out again, differently (its title changed here).
    const source = spaceShareSource(s.world.store, s.world.plan)!;
    const main = source.local.documents.find((d) => d.id === s.world.main)!;
    main.title = "Renamed plan";
    main.doc_path = null;
    return source;
  };

  test("the space a key brings back is found by the version its main page holds when its path is worked out differently now: no second main page", async () => {
    const s = setup({ token: true, seed: { extras: false } });
    expect((await s.run()).end).toBe("done");
    const path = s.record.pages[s.world.main]!.doc_path;
    const { again, result, later } = await shareAgain(s, renamed(s));
    expect(result.end).toBe("done");
    expect(again.pages[s.world.main]).toMatchObject({ doc_path: path, pushed: [{ local: 4 }], stopped: null });
    expect(later.filter((c) => c.method === "POST" && c.path.endsWith("/documents"))).toHaveLength(0);
    expect(spaceOf(s.spaces, again).documents).toHaveLength(1);
  });

  test("the space a key brings back has pages and none is the main page: nothing is added, and it is gone (Share as new), never a Try again that loops", async () => {
    const s = setup({ token: true, seed: { extras: false } });
    expect((await s.run()).end).toBe("done");
    s.spaces.editPage(s.record.space_id, s.record.pages[s.world.main]!.doc_path, "# Rewritten in the space\n");
    const { again, result, later } = await shareAgain(s, renamed(s));
    expect([result.end, result.error?.code]).toEqual(["failed", "no_main_page"]);
    expect(again.job).toMatchObject({ ended: "failed", gone: true });
    expect(again.created).toBe(false);
    expect(later.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path === "/v1/workspaces"}`)).toEqual(["POST true"]);
    expect(spaceOf(s.spaces, s.record).documents).toHaveLength(1);
  });

  test("the record is lost, the space holds v1 to v4 and there is a v5 here: v5 and its new comment go up, nothing twice", async () => {
    const s = setup({ token: true, seed: { extras: false } });
    expect((await s.run()).end).toBe("done");
    const { store, plan, main } = s.world;
    store.addVersion(plan, main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    const v5 = store.versions(plan, main).slice(-1)[0]!;
    store.saveComment(plan, { document_id: main, document_version: v5.version, annotation: { id: "open-5", type: "COMMENT", text: "On v5." }, at: new Date().toISOString() });
    const { again, result, later } = await shareAgain(s);
    expect(result.end).toBe("done");
    expect(again.space_id).toBe(s.record.space_id);
    expect(again.pages[main]!.pushed.map((p) => p.local)).toEqual([4, 5]);
    expect(later.filter((c) => c.method === "PATCH").map((c) => c.status)).toEqual([200]);
    expect(later.filter((c) => c.method === "POST" && c.path.endsWith("/documents"))).toHaveLength(0);
    const space = spaceOf(s.spaces, again);
    expect(mainOf({ ...s, record: again }).versions.map((v) => v.version)).toEqual(store.versions(plan, main).map((v) => v.version));
    // The comment already up is the same one (its key); the new one is added once.
    expect(space.comments.map((c) => c.body).sort()).toEqual(["On v5.", "Should the Free tier burst be lower?"]);
  });

  test("by version only when exactly one page there holds a version of the main page: two pages with the same bytes are no match", async () => {
    const s = setup({ token: true, seed: { extras: false } });
    expect((await s.run()).end).toBe("done");
    const head = new TextDecoder().decode(s.world.store.versionBytes(s.world.plan, s.world.main, 4)!);
    await createSpacesClient({ host: HOST, token: s.token, fetch: s.spaces.fetch }).addPage(s.record.space_id, { doc_path: "Copy.md", kind: "markdown", title: "Copy", body: head });
    const { again, result, later } = await shareAgain(s, renamed(s));
    expect([result.end, result.error?.code]).toEqual(["failed", "no_main_page"]);
    expect(again.job).toMatchObject({ gone: true });
    expect(later.filter((c) => c.method !== "GET").map((c) => c.method)).toEqual(["POST"]);
  });

  test("409 external_key_conflict, or an id the share cannot keep: gone (Share as new), not a Try again that gets the same answer", async () => {
    const s = setup({ token: true, seed: { extras: false } });
    s.spaces.failNext(/^POST \/v1\/workspaces$/, 409, "external_key_conflict", { details: { workspace_id: newSpaceId(), org_id: "org_1" } });
    expect((await s.run()).end).toBe("failed");
    expect(s.record.job).toMatchObject({ ended: "failed", gone: true });
    const odd = setup({ token: true, seed: { extras: false } });
    const oddFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await odd.spaces.fetch(input, init);
      if (init?.method !== "POST" || !String(input).endsWith("/v1/workspaces")) return answer;
      const body = (await answer.json()) as { workspace: Record<string, unknown>; document: unknown };
      return new Response(JSON.stringify({ ...body, workspace: { ...body.workspace, id: "space-42" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const result = await runSpaceShare({ source: spaceShareSource(odd.world.store, odd.world.plan)!, record: odd.record, save: () => {}, client: createSpacesClient({ host: HOST, token: odd.token, fetch: oddFetch }) });
    expect([result.end, result.error?.code]).toEqual(["failed", "unknown_space_id"]);
    expect(odd.record.job).toMatchObject({ ended: "failed", gone: true });
    expect(odd.record.created).toBe(false);
  });

  test("a record kept before the share time was: the create's time is kept now, so the call tried again is the same", async () => {
    const s = setup({ seed: { extras: false } });
    s.record.seed = { doc: s.world.main, version: 1 };
    const at = "2026-11-20T10:00:00.000Z";
    expect((await runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }), now: () => Date.parse(at) })).end).toBe("done");
    expect(s.record.seed!.at).toBe(at);
    expect((s.spaces.calls.find((c) => c.path === "/v1/workspaces")!.json as { actor: { at: string } }).actor.at).toBe(at);
  });

  test("the key names the same team or none: a call naming another team for it is refused by the space", async () => {
    const s = setup({ token: true, seed: { extras: false } });
    expect((await s.run()).end).toBe("done");
    const client = createSpacesClient({ host: HOST, token: s.token, fetch: s.spaces.fetch });
    const other = await client.createSpace({ id: newSpaceId(), name: "x", document: null, external_key: s.world.plan, org_id: "org_1" } as Parameters<typeof client.createSpace>[0]).catch((e: { status: number; code: string; details: Record<string, unknown> }) => [e.status, e.code, e.details.workspace_id]);
    expect(other).toEqual([409, "external_key_conflict", s.record.space_id]);
  });
});

describe("a comment too long for the space", () => {
  const longComment = (s: ReturnType<typeof setup>, id: string, text: string, originalText = "The public API") => {
    const head = s.world.store.versions(s.world.plan, s.world.main).slice(-1)[0]!;
    return s.world.store.saveComment(s.world.plan, { document_id: s.world.main, document_version: head.version, annotation: { id, type: "COMMENT", text, originalText }, at: new Date().toISOString() });
  };

  test("over 8 KB of words, or a call over 32 KB once its words are written as JSON: never sent, counted under Not shared, and the share finishes", async () => {
    const s = setup({ seed: { extras: false } });
    longComment(s, "long-1", "x".repeat(8 * 1024 + 1));
    // Under 8 KB as text and an anchor under 16 KB, but a call over 32 KB: control characters weigh six bytes as JSON.
    const words = "\u0001".repeat(2708);
    const probe = longComment(s, "long-2", words);
    const anchorBytes = enc(JSON.stringify(spaceCommentAnchor(probe))).length;
    const padded = longComment(s, "long-2", words, "y".repeat(16_384 - anchorBytes + "The public API".length));
    expect(enc(padded.body).length).toBeLessThanOrEqual(8 * 1024);
    expect(enc(JSON.stringify(spaceCommentAnchor(padded))).length).toBeLessThanOrEqual(16 * 1024);
    expect(enc(JSON.stringify({ anchor: spaceCommentAnchor(padded), body: padded.body, document_version: "0".repeat(40), actor: { kind: "imported", at: new Date().toISOString() } })).length).toBeGreaterThan(32 * 1024);
    const source = spaceShareSource(s.world.store, s.world.plan)!;
    expect(planSpaceShare(source.local, null, { mode: "all", signedIn: false }).details.not.long_comments).toBe(2);
    expect((await s.run()).end).toBe("done");
    const sent = s.spaces.calls.filter((c) => c.path.endsWith("/annotations"));
    expect(sent.map((c) => c.idempotencyKey)).toEqual([s.world.unsent]);
    expect(s.spaces.calls.some((c) => c.status === 413 || c.status === 422)).toBe(false);
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
    expect((await runSpaceShare({ source: again, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }) })).end).toBe("done");
    expect(s.spaces.spaces.size).toBe(1);
    expect(mainOf(s).versions.map((v) => v.body.includes("v5"))).toEqual([false, true]);
  });

  test("a page add, a save and a comment whose answers were lost are not made twice", async () => {
    const s = setup();
    s.spaces.failNext(/^POST .*\/documents$/, 0, "lost", { after: true });
    s.spaces.failNext(/^PATCH .*\/documents\//, 0, "lost", { after: true });
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
    const stopped = await runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client, signal: abort.signal });
    expect(stopped.end).toBe("stopped");
    expect(s.record.job).toMatchObject({ done: 3, ended: "stopped" });
    expect((await s.run()).end).toBe("done");
    expect(writes(s.spaces)).toHaveLength(12);
  });
});

describe("ended from outside", () => {
  const until = (calls: number, reason: string) => async (s: ReturnType<typeof setup>) => {
    const abort = new AbortController();
    let seen = 0;
    const client = createSpacesClient({ host: HOST, signal: abort.signal, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await s.spaces.fetch(input, init);
      if (++seen === calls) abort.abort(reason);
      return response;
    }) as typeof fetch });
    return runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client, signal: abort.signal });
  };

  test("the server going down is not the person's Stop: the record stays a run not finished, and the next run goes on", async () => {
    const s = setup();
    await until(3, "shutdown")(s);
    expect(s.record.job).toEqual({ done: 3, total: 12, ended: null });
    const stopped = setup();
    await until(3, "stop")(stopped);
    expect(stopped.record.job).toMatchObject({ done: 3, ended: "stopped" });
    expect((await s.run()).end).toBe("done");
    expect(writes(s.spaces)).toHaveLength(12);
  });
});

describe("the sign-in and the limit", () => {
  test("only a credential the space itself refuses (401 unauthorized) is forgotten; any other 401 is not", async () => {
    for (const [code, forgotten] of [["unauthorized", true], ["login_required", false], ["http_401", false]] as const) {
      const s = setup({ token: true, seed: { extras: false } });
      s.spaces.failNext(/^PATCH .*\/documents\//, 401, code);
      const result = await s.run();
      expect([code, result.end, result.signedOut ?? false]).toEqual([code, "failed", forgotten]);
    }
  });

  test("the space's own quota answer is over the limit, signed in or not", async () => {
    const s = setup({ token: true });
    s.spaces.failNext(/assets\//, 413, "quota_exceeded");
    expect((await s.run()).end).toBe("over_limit");
  });

  test("started signed in, made, and the claim after the create got no answer: the claim is made first on the next run, and the 100 MB count for a space nobody owns is not applied meanwhile", async () => {
    const s = setup({ token: true, seed: { extras: false } });
    s.record.signed = true;
    s.spaces.failNext(/claim$/, 502, "bad_gateway");
    expect((await s.run()).end).toBe("failed");
    expect([s.record.created, s.record.kept, s.record.refused]).toEqual([true, false, false]);
    // Files that a space nobody owns could not hold together: not refused here, since this space is taken as the person's own.
    const source = spaceShareSource(s.world.store, s.world.plan)!;
    for (const [path, hash] of [["big-1.bin", "e"], ["big.bin", "f"]]) source.local.artifacts.push({ asset_path: path!, content_hash: hash!.repeat(64), content_type: "application/octet-stream", size: 60_000_000, title: null, created_at: new Date().toISOString() });
    const again = await runSpaceShare({ source: { ...source, artifactBytes: () => new Uint8Array([1]) }, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, token: s.token, fetch: s.spaces.fetch }) });
    expect(again.end).toBe("done");
    expect(s.record.kept).toBe(true);
    const order = s.spaces.calls.filter((c) => c.method !== "GET").map((c) => c.path.split("/").pop());
    expect(order.indexOf("claim")).toBeLessThan(order.lastIndexOf("big.bin"));
    // The same file into a space nobody owns is over the limit before anything is sent.
    const open = setup({ seed: { extras: false } });
    const openSource = spaceShareSource(open.world.store, open.world.plan)!;
    for (const [path, hash] of [["big-1.bin", "e"], ["big.bin", "f"]]) openSource.local.artifacts.push({ asset_path: path!, content_hash: hash!.repeat(64), content_type: "application/octet-stream", size: 60_000_000, title: null, created_at: new Date().toISOString() });
    expect((await runSpaceShare({ source: openSource, record: open.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: open.spaces.fetch }) })).end).toBe("over_limit");
    expect(open.spaces.calls).toHaveLength(0);
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
    expect((await runSpaceShare({ source: next, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }) })).end).toBe("done");
    expect(writes(s.spaces).slice(12)).toEqual(["PATCH /v1/workspaces/ws/documents/doc"]);
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
    const run = () => runSpaceShare({ source: spaceShareSource(store, plan)!, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }) });
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

  test("a page save the space does not allow: the run stops for Keep, and never says whose the space is", async () => {
    const s = setup();
    await s.run();
    s.spaces.keptBy(s.record.space_id, "Someone Else");
    s.world.store.addVersion(s.world.plan, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    const result = await runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }) });
    expect(result.end).toBe("keep");
    expect(s.record.refused).toBe(false);
    expect(s.record.job).toMatchObject({ ended: "failed", keep: true });
    expect(mainOf(s).versions).toHaveLength(4);
  });

  test("kept by someone else with its link still open: an imported comment alone is refused (403 imported_owner_only) and the run stops for Keep, as a page save does", async () => {
    const s = setup();
    await s.run();
    s.spaces.keptBy(s.record.space_id, "Someone Else");
    const head = s.world.store.versions(s.world.plan, s.world.main)[3]!;
    s.world.store.saveComment(s.world.plan, { document_id: s.world.main, document_version: head.version, annotation: { id: "open-2", text: "And Team?" }, at: new Date().toISOString() });
    const run = () => runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }) });
    expect((await run()).end).toBe("keep");
    const last = s.spaces.calls[s.spaces.calls.length - 1]!;
    expect([last.method, last.path.endsWith("/annotations"), last.status, last.code]).toEqual(["POST", true, 403, "imported_owner_only"]);
    expect(spaceOf(s.spaces, s.record).comments).toHaveLength(1);
    expect(s.record.refused).toBe(false);
    expect(s.record.job).toMatchObject({ ended: "failed", keep: true });
  });

  const gone: [string, (s: ReturnType<typeof setup>) => void, boolean][] = [
    ["the space expired or was removed (no account: 401 login_required)", (s) => s.spaces.remove(s.record.space_id), true],
    ["someone kept it and made it private (no account: 401 login_required)", (s) => s.spaces.keptBy(s.record.space_id, "Someone Else", true), true],
    ["a route the service does not have (404 not_found)", (s) => s.spaces.failNext(/^PATCH .*\/documents\//, 404, "not_found"), false],
    ["the service failing (502)", (s) => s.spaces.failNext(/^PATCH .*\/documents\//, 502, "bad_gateway"), false],
  ];
  for (const [name, arrange, isGone] of gone) {
    test(`${name}: a run that did not finish, never "someone else kept it", never a new space by itself`, async () => {
      const s = setup();
      await s.run();
      const link = s.record.share_url;
      s.world.store.addVersion(s.world.plan, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
      arrange(s);
      const result = await runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, fetch: s.spaces.fetch }) });
      expect([result.end, result.signedOut ?? false, s.record.refused]).toEqual(["failed", false, false]);
      expect(s.record.job).toMatchObject({ ended: "failed" });
      // Only where the space is not there for this caller is "Share as new" the way on.
      expect(s.record.job!.gone === true).toBe(isGone);
      expect(s.spaces.spaces.size).toBe(1);
      expect(s.record.share_url).toBe(link);
    });
  }

  test("signed in, and the space is gone (404 workspace_not_found): did not finish, the sign-in is kept", async () => {
    const s = setup({ token: true, seed: { extras: false } });
    await s.run();
    s.world.store.addVersion(s.world.plan, s.world.main, { bytes: enc("# Rate limiting\n\nv5\n"), committed_at: new Date().toISOString(), source: "plan-review" });
    s.spaces.remove(s.record.space_id);
    const result = await s.run();
    expect([result.end, result.signedOut ?? false, s.record.job!.gone]).toEqual(["failed", false, true]);
    expect(s.spaces.spaces.size).toBe(1);
  });

  test("a file whose name the space does not take goes up under another name, once", async () => {
    const s = setup({ seed: { extras: false, versions: 1, approve: false } });
    s.world.store.addArtifact(s.world.plan, { asset_path: "q#3 50%.png", content_type: "image/png", created_at: new Date().toISOString(), bytes: new Uint8Array([1, 2, 3]) });
    expect((await s.run()).end).toBe("done");
    expect(spaceOf(s.spaces, s.record).assets.map((a) => a.path)).toEqual(["q-3 50-.png"]);
    expect(s.record.files["q#3 50%.png"]!.remote_path).toBe("q-3 50-.png");
    const before = s.spaces.calls.length;
    expect((await s.run()).end).toBe("done");
    expect(s.spaces.calls.length).toBe(before);
  });

  test("more files than a space nobody kept may hold: over the limit, with what is up kept", async () => {
    const s = setup({ spaces: { openQuota: 80 } });
    expect((await s.run()).end).toBe("over_limit");
    expect(s.record.job!.ended).toBe("over_limit");
    expect(s.record.share_url).not.toBeNull();
  });
});

describe("whose the space is", () => {
  test("kept only when the space says so: a signed-in create is the person's own", async () => {
    const s = setup({ token: true, seed: { extras: false } });
    expect(s.record.kept).toBe(false);
    expect((await s.run()).end).toBe("done");
    expect(s.record.kept).toBe(true);
    expect(spaceOf(s.spaces, s.record).owner).toBe("Maya Chen");
  });

  test("made without sign-in and its answer lost, then tried again signed in: the ownerless space is claimed, never called kept unclaimed", async () => {
    const s = setup({ seed: { extras: false } });
    s.spaces.failNext(/^POST \/v1\/workspaces$/, 0, "lost", { after: true });
    expect((await s.run()).end).toBe("failed");
    expect(spaceOf(s.spaces, s.record).owner).toBeNull();
    const token = s.spaces.issueToken("Maya Chen");
    const signedIn = () => runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, token, fetch: s.spaces.fetch }) });
    expect((await signedIn()).end).toBe("done");
    expect(s.spaces.spaces.size).toBe(1);
    expect(spaceOf(s.spaces, s.record).owner).toBe("Maya Chen");
    expect(s.record.kept).toBe(true);
  });

  test("the same, but it has another owner by then: the run stops for Keep; only the person's own Keep says it is someone else's", async () => {
    const s = setup({ seed: { extras: false } });
    s.spaces.failNext(/^POST \/v1\/workspaces$/, 0, "lost", { after: true });
    await s.run();
    s.spaces.keptBy(s.record.space_id, "Someone Else");
    const token = s.spaces.issueToken("Maya Chen");
    const result = await runSpaceShare({ source: spaceShareSource(s.world.store, s.world.plan)!, record: s.record, save: () => {}, client: createSpacesClient({ host: HOST, token, fetch: s.spaces.fetch }) });
    expect([result.end, s.record.kept, s.record.refused, s.record.job?.keep]).toEqual(["keep", false, false, true]);
  });
});

describe("the approval", () => {
  test("a run never sends one, even signed in to the person's own space, and the next run calls nothing for it", async () => {
    // A tool's approval call is always refused: the approval goes up only with Keep, on the sign-in page.
    const s = setup({ token: true, spaces: { approvals: "accept" } });
    expect((await s.run()).end).toBe("done");
    expect(writes(s.spaces).filter((w) => w.endsWith("/approval"))).toEqual([]);
    expect(spaceOf(s.spaces, s.record).owner).toBe("Maya Chen");
    expect(spaceOf(s.spaces, s.record).approvals).toEqual([]);
    expect([s.record.approval, s.record.approval_refused]).toEqual([null, undefined]);
    // Every call carried the sign-in in its header, and none in its address.
    expect(s.spaces.calls.every((c) => c.signedIn && !`${c.path}${c.query}`.includes(s.token!))).toBe(true);
    const before = s.spaces.calls.length;
    expect((await s.run()).end).toBe("done");
    expect(s.spaces.calls.length).toBe(before);
  });
});

describe("the client's page save", () => {
  const actor = { actor: { kind: "imported", at: "2026-11-20T10:00:00.000Z" } };
  /** A server that answers after `ms`, and keeps what it was sent. */
  const slow = (ms: number, seen: { method: string; type: string | null; body: string }[] = []) =>
    (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push({ method: init?.method ?? "GET", type: new Headers(init?.headers).get("content-type"), body: init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body ?? "") });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        init?.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))), { once: true });
      });
      return new Response(JSON.stringify({ id: "doc", version: "a".repeat(40) }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

  test("a big JSON save gets longer before it counts as not answered, as raw bytes did", async () => {
    const client = (timeoutMs: number) => createSpacesClient({ host: HOST, fetch: slow(120), timeoutMs });
    // 20 KB: 400 ms more than the 10 ms the call is given; a tiny page gets no more and is not answered in time.
    expect((await client(10).savePage(newSpaceId(), "doc", enc("x".repeat(20_000)), "markdown", "b".repeat(40), actor)).version).toBe("a".repeat(40));
    expect(await client(10).savePage(newSpaceId(), "doc", enc("x"), "markdown", "b".repeat(40), actor).catch((e: { code: string }) => e.code)).toBe("offline");
  });

  test("a page whose bytes are not UTF-8 goes as it is, by the raw PUT and with no actor; a UTF-8 one by the JSON PATCH", async () => {
    const seen: { method: string; type: string | null; body: string }[] = [];
    const client = createSpacesClient({ host: HOST, fetch: slow(0, seen) });
    await client.savePage(newSpaceId(), "doc", new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x41]), "markdown", "b".repeat(40), actor);
    await client.savePage(newSpaceId(), "doc", enc("# Fine\n"), "markdown", "b".repeat(40), actor);
    expect(seen.map((c) => [c.method, c.type?.split(";")[0], c.body.includes("imported")])).toEqual([
      ["PUT", "text/markdown", false],
      ["PATCH", "application/json", true],
    ]);
  });
});
