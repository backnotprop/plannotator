/**
 * Plans' routes, in process through the runtime-neutral handler (no server), on a scratch data dir. What regresses
 * if these fail:
 * - the list, a plan, its versions or one version's bytes cannot be read, or another document's are served;
 * - the diff gets the wrong pair (it must start from the version the person last saw);
 * - a look records a version that does not exist, takes a bad body, or answers a GET;
 * - a comment is not kept on the version it names, an edit makes a second one, a bad or oversized one is kept, or one
 *   taken away comes back;
 * - a path that is not a plan id, or a malformed one, crashes instead of answering 4xx;
 * - an artifact is served as something that could run on the Inbox's origin (HTML, SVG), or a path that is not a
 *   recorded artifact (one reaching outside the plan's `files/`) is served at all;
 * - approval "plans-editing": the person's edit is not a new person version with plan review's Direct Edits diff for
 *   the agent, a stale base or a save that changes nothing writes a version, a diagram is edited, a Restore does not
 *   make a new newest version of the older text, an approval is given on a version the plan moved past, or a Send
 *   does not mark its comments sent and record the plan's thread.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_PERSON, PLAN_PICTURE_TYPES, planApprovalState, planId } from "@plannotator/core/plans";
import { createPlanStore } from "./store";
import { artifactServedType, handlePlanRoute, isPlansPath, type PlanRouteResult } from "./routes";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world() {
  const dataDir = mkdtempSync(join(tmpdir(), "plans-routes-"));
  dirs.push(dataDir);
  const store = createPlanStore({ dataDir });
  const { plan, document } = store.createPlan({ name: "Auth refactor", created_at: "2026-11-01T09:00:00.000Z", document: { title: "Auth refactor" } });
  for (const [n, day] of [[1, 2], [2, 3], [3, 4]] as const) {
    store.addVersion(plan.id, document.id, { bytes: new TextEncoder().encode(`# Auth refactor\n\nv${n}\n`), committed_at: `2026-11-0${day}T09:00:00.000Z`, source: "plan-review" });
  }
  let changed: string[] = [];
  const call = (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://localhost${path}`);
    return handlePlanRoute(
      { method, pathname: url.pathname, params: url.searchParams, json: async () => (typeof body === "string" ? JSON.parse(body) : body) },
      { store, changed: (id) => changed.push(id), importing: () => false },
    );
  };
  return { store, plan, doc: document.id, call, changes: () => changed, reset: () => (changed = []) };
}

const body = (result: PlanRouteResult | null) => (result && "body" in result ? (result.body as Record<string, any>) : null);

describe("Plans' routes", () => {
  test("only /api/plans paths are theirs", async () => {
    const { call } = world();
    expect(isPlansPath("/api/plans")).toBe(true);
    expect(isPlansPath("/api/plansx")).toBe(false);
    expect(await call("GET", "/api/plansx")).toBeNull();
    expect(await call("GET", "/api/shapes")).toBeNull();
  });

  test("the list, one plan and its versions", async () => {
    const { plan, doc, call } = world();
    const list = await call("GET", "/api/plans");
    expect(list?.status).toBe(200);
    expect(body(list)!.importing).toBe(false);
    expect(body(list)!.plans.map((p: { id: string; head_version_number: number }) => [p.id, p.head_version_number])).toEqual([[plan.id, 3]]);

    const one = body(await call("GET", `/api/plans/${plan.id}`))!;
    expect(one.plan.id).toBe(plan.id);
    expect(one.documents.map((d: { id: string }) => d.id)).toEqual([doc]);
    expect(one.look).toBeNull();

    const versions = body(await call("GET", `/api/plans/${plan.id}/versions`))!;
    expect(versions.versions.map((v: { version_number: number }) => v.version_number)).toEqual([1, 2, 3]);
  });

  test("one version's bytes are its file, as markdown", async () => {
    const { plan, call } = world();
    const answer = await call("GET", `/api/plans/${plan.id}/versions/2`);
    expect(answer && "file" in answer).toBe(true);
    if (!answer || !("file" in answer)) return;
    expect(answer.file.contentType).toBe("text/markdown; charset=utf-8");
    expect(readFileSync(answer.file.path, "utf8")).toBe("# Auth refactor\n\nv2\n");
    expect((await call("GET", `/api/plans/${plan.id}/versions/9`))?.status).toBe(404);
    expect((await call("GET", `/api/plans/${plan.id}/versions/02`))?.status).toBe(404);
    expect((await call("GET", `/api/plans/${plan.id}/versions/1?doc=${planId("doc")}`))?.status).toBe(404);
  });

  test("the diff starts from the version last seen, else the one before; named versions win", async () => {
    const { plan, call } = world();
    const first = body(await call("GET", `/api/plans/${plan.id}/diff`))!;
    expect([first.from.version_number, first.to.version_number, first.seen]).toEqual([2, 3, null]);
    expect(first.to.text).toBe("# Auth refactor\n\nv3\n");
    await call("POST", `/api/plans/${plan.id}/look`, { seen: 1 });
    const seen = body(await call("GET", `/api/plans/${plan.id}/diff`))!;
    expect([seen.from.version_number, seen.to.version_number, seen.seen]).toEqual([1, 3, 1]);
    const named = body(await call("GET", `/api/plans/${plan.id}/diff?from=1&to=2`))!;
    expect([named.from.version_number, named.to.version_number]).toEqual([1, 2]);
    expect((await call("GET", `/api/plans/${plan.id}/diff?to=7`))?.status).toBe(404);
  });

  test("a look records the seen version and says so; a bad one is refused", async () => {
    const { store, plan, call, changes } = world();
    const looked = await call("POST", `/api/plans/${plan.id}/look`, { seen: 3 });
    expect(looked?.status).toBe(200);
    expect(store.list()[0]).toMatchObject({ seen_version_number: 3, changed: false });
    expect(changes()).toEqual([plan.id]);
    expect((await call("POST", `/api/plans/${plan.id}/look`, { seen: 4 }))?.status).toBe(400);
    expect((await call("POST", `/api/plans/${plan.id}/look`, { seen: "3" }))?.status).toBe(400);
    expect((await call("POST", `/api/plans/${plan.id}/look`, { doc: planId("doc") }))?.status).toBe(404);
    expect((await call("POST", `/api/plans/${plan.id}/look`, "{ bad"))?.status).toBe(400);
    expect((await call("GET", `/api/plans/${plan.id}/look`))?.status).toBe(405);
    expect((await call("POST", "/api/plans"))?.status).toBe(405);
  });

  test("a comment is kept on its version, edited in place, read back with the plan and taken away; a bad one is refused", async () => {
    const { store, plan, doc, call, changes } = world();
    const v2 = store.versions(plan.id)[1]!;
    const annotation = { id: "ann-1", blockId: "block-1", type: "COMMENT", text: "Say who owns it.", originalText: "v2" };
    const saved = await call("POST", `/api/plans/${plan.id}/comments`, { version: 2, annotation, serverSession: "s" });
    expect(saved?.status).toBe(200);
    expect(body(saved)!.comment).toMatchObject({ plan_id: plan.id, target: { kind: "document", document_id: doc, document_version: v2.version }, body: "Say who owns it.", state: "open", sent: null, author_via: "person" });
    expect(changes()).toEqual([plan.id]);
    // The same annotation again is an edit: one comment, its words new, its id and time kept.
    const edited = await call("POST", `/api/plans/${plan.id}/comments`, { version: 2, annotation: { ...annotation, text: "Name the owner." } });
    expect(body(edited)!.comment).toMatchObject({ id: body(saved)!.comment.id, created_at: body(saved)!.comment.created_at, body: "Name the owner." });
    expect(body(await call("GET", `/api/plans/${plan.id}`))!.comments.map((c: { body: string }) => c.body)).toEqual(["Name the owner."]);
    // On another version, the same annotation id is refused; so are bad bodies and unknown versions.
    expect((await call("POST", `/api/plans/${plan.id}/comments`, { version: 3, annotation }))?.status).toBe(409);
    expect((await call("POST", `/api/plans/${plan.id}/comments`, { version: 9, annotation }))?.status).toBe(404);
    expect((await call("POST", `/api/plans/${plan.id}/comments`, { version: 2, annotation: { text: "no id" } }))?.status).toBe(400);
    expect((await call("POST", `/api/plans/${plan.id}/comments`, { version: 2, annotation: { id: "big", text: "x".repeat(140_000) } }))?.status).toBe(400);
    expect((await call("POST", `/api/plans/${plan.id}/comments`, { version: 2, annotation, extra: 1 }))?.status).toBe(400);
    expect((await call("GET", `/api/plans/${plan.id}/comments`))?.status).toBe(405);
    // Taken away: gone from the plan; a second time there is nothing to take.
    expect((await call("POST", `/api/plans/${plan.id}/comments/ann-1/remove`, {}))?.status).toBe(200);
    expect(store.comments(plan.id)).toEqual([]);
    expect((await call("POST", `/api/plans/${plan.id}/comments/ann-1/remove`, {}))?.status).toBe(404);
  });

  test("Done: the person's edit of the newest is a new person version, with plan review's Direct Edits for the agent", async () => {
    const { store, plan, doc, call, changes } = world();
    const saved = await call("POST", `/api/plans/${plan.id}/versions`, { base: 3, text: "# Auth refactor\n\nv3, edited by hand\n", serverSession: "s" });
    expect(saved?.status).toBe(200);
    expect(body(saved)!.version).toMatchObject({ version_number: 4, source: "person", author_via: "person", agent_session: null });
    expect(new TextDecoder().decode(store.versionBytes(plan.id, doc, 4)!)).toBe("# Auth refactor\n\nv3, edited by hand\n");
    const edits: string = body(saved)!.direct_edits;
    expect(edits.startsWith("# Direct Edits\n\nThe user edited the document directly.")).toBe(true);
    expect(edits).toContain("-v3\n+v3, edited by hand");
    expect(changes()).toEqual([plan.id]);
  });

  test("a stale base is refused with the newest (nothing written), and so is a save that changes nothing", async () => {
    const { store, plan, call } = world();
    const stale = await call("POST", `/api/plans/${plan.id}/versions`, { base: 2, text: "# Mine\n" });
    expect(stale?.status).toBe(409);
    expect(body(stale)).toMatchObject({ code: "moved_on", head: { version_number: 3 } });
    const same = await call("POST", `/api/plans/${plan.id}/versions`, { base: 3, text: "# Auth refactor\n\nv3\n" });
    expect(same?.status).toBe(409);
    expect(body(same)!.code).toBe("unchanged");
    expect((await call("POST", `/api/plans/${plan.id}/versions`, { base: 3, restore: 3 }))?.status).toBe(409);
    expect(store.versions(plan.id).length).toBe(3);
    // A bad body, an unknown base, both a text and a restore: refused.
    expect((await call("POST", `/api/plans/${plan.id}/versions`, { base: 9, text: "x" }))?.status).toBe(404);
    expect((await call("POST", `/api/plans/${plan.id}/versions`, { base: 3, text: "x", restore: 1 }))?.status).toBe(400);
    expect((await call("POST", `/api/plans/${plan.id}/versions`, { text: "x" }))?.status).toBe(400);
    expect(store.versions(plan.id).length).toBe(3);
  });

  test("never an edit of a diagram; a Restore makes a new newest version of the older text", async () => {
    const { store, plan, doc, call } = world();
    const flow = store.addDocument(plan.id, { title: "Flow", kind: "mermaid", created_at: "2026-11-05T09:00:00.000Z" });
    store.addVersion(plan.id, flow.id, { bytes: new TextEncoder().encode("flowchart LR\n  A --> B\n"), committed_at: "2026-11-05T09:00:00.000Z", source: "agent-tool" });
    expect((await call("POST", `/api/plans/${plan.id}/versions`, { doc: flow.id, base: 1, text: "flowchart LR\n  A --> C\n" }))?.status).toBe(400);
    const restored = await call("POST", `/api/plans/${plan.id}/versions`, { base: 3, restore: 1 });
    expect(restored?.status).toBe(200);
    expect(body(restored)!.version).toMatchObject({ version_number: 4, source: "person", restored_from: 1 });
    expect(new TextDecoder().decode(store.versionBytes(plan.id, doc, 4)!)).toBe("# Auth refactor\n\nv1\n");
  });

  test("approve names the version on screen: refused once the plan moved on; the approval is that version's only", async () => {
    const { store, plan, doc, call } = world();
    const refused = await call("POST", `/api/plans/${plan.id}/approve`, { version: 2 });
    expect(refused?.status).toBe(409);
    expect(body(refused)).toMatchObject({ code: "moved_on", head: { version_number: 3 } });
    expect(store.events(plan.id).filter((e) => e.kind === "decision")).toEqual([]);
    const approved = await call("POST", `/api/plans/${plan.id}/approve`, { version: 3 });
    expect(approved?.status).toBe(200);
    expect(body(approved)!.decision).toMatchObject({ decision: "approved", version_number: 3, document_id: doc });
    // Again: the same approval, not a second one.
    await call("POST", `/api/plans/${plan.id}/approve`, { version: 3 });
    expect(store.events(plan.id).filter((e) => e.kind === "decision").length).toBe(1);
    expect(planApprovalState(store.events(plan.id), doc, 3)).toMatchObject({ kind: "approved", names: [PLAN_PERSON] });
    expect(store.list()[0]!.approval).toMatchObject({ kind: "approved", version_number: 3 });
  });

  test("a Send that went marks its comments sent and gives the plan its thread (the first one stays)", async () => {
    const { store, plan, call } = world();
    for (const id of ["ann-1", "ann-2"]) await call("POST", `/api/plans/${plan.id}/comments`, { version: 3, annotation: { id, type: "COMMENT", text: id } });
    const sent = await call("POST", `/api/plans/${plan.id}/sent`, { thread_id: "msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ", message_id: "msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ", to: { host: "claude-code", session: "s-1" }, comments: ["ann-1"] });
    expect(sent?.status).toBe(200);
    expect(store.get(plan.id)!.thread_id).toBe("msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ");
    const byId = new Map(store.comments(plan.id).map((c) => [(c.anchor as { id: string }).id, c]));
    expect(byId.get("ann-1")!.sent).toMatchObject({ message_id: "msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ", to: { host: "claude-code", session: "s-1" } });
    expect(byId.get("ann-2")!.sent).toBeNull();
    // A sent comment is no longer edited or taken away; a later Send keeps the plan's first thread.
    expect((await call("POST", `/api/plans/${plan.id}/comments`, { version: 3, annotation: { id: "ann-1", text: "again" } }))?.status).toBe(409);
    await call("POST", `/api/plans/${plan.id}/sent`, { thread_id: "msg_01M7JKWTSFEGR2XJQEJ1R2GHCZ", message_id: "msg_01M7JKWTSFEGR2XJQEJ1R2GHCZ", comments: ["ann-2"] });
    expect(store.get(plan.id)!.thread_id).toBe("msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ");
    expect((await call("POST", `/api/plans/${plan.id}/sent`, { thread_id: "x y", message_id: "m", comments: [] }))?.status).toBe(400);
  });

  test("not a plan, an unknown plan, an unknown path or bad encoding answer 4xx", async () => {
    const { plan, call } = world();
    expect((await call("GET", "/api/plans/shp_1"))?.status).toBe(404);
    expect((await call("GET", `/api/plans/${planId("pln")}`))?.status).toBe(404);
    expect((await call("GET", `/api/plans/${plan.id}/nope`))?.status).toBe(404);
    expect((await call("GET", "/api/plans/%E0%A4%A"))?.status).toBe(400);
  });

  test("a plan's other documents and artifacts: listed, read, and served as nothing that could run", async () => {
    const { store, plan, call } = world();
    const notes = store.addDocument(plan.id, { title: "Rollout", created_at: "2026-11-05T09:00:00.000Z" });
    store.addVersion(plan.id, notes.id, { bytes: new TextEncoder().encode("# Rollout\n"), committed_at: "2026-11-05T09:00:00.000Z", source: "agent-tool" });
    const at = "2026-11-06T09:00:00.000Z";
    store.addArtifact(plan.id, { asset_path: "shots/screen.png", bytes: new Uint8Array([137, 80, 78, 71]), content_type: "image/png", created_at: at });
    store.addArtifact(plan.id, { asset_path: "mockup.html", bytes: new TextEncoder().encode("<script>alert(1)</script>"), content_type: "text/html", created_at: at });
    store.addArtifact(plan.id, { asset_path: "flow.svg", bytes: new TextEncoder().encode("<svg/>"), content_type: "image/svg+xml", created_at: at });
    store.addArtifact(plan.id, { asset_path: "spec.pdf", bytes: new Uint8Array([37, 80, 68, 70]), content_type: "application/pdf", created_at: at });

    const one = body(await call("GET", `/api/plans/${plan.id}`))!;
    expect(one.documents.map((d: { title: string }) => d.title).sort()).toEqual(["Auth refactor", "Rollout"]);
    expect(one.artifacts.map((a: { asset_path: string }) => a.asset_path)).toEqual(["flow.svg", "mockup.html", "shots/screen.png", "spec.pdf"]);
    expect(store.list()[0]!.counts.artifacts).toBe(4);
    expect(body(await call("GET", `/api/plans/${plan.id}/versions?doc=${notes.id}`))!.versions.length).toBe(1);

    const served = async (path: string) => {
      const answer = await call("GET", `/api/plans/${plan.id}/files/${path}`);
      return answer && "file" in answer ? { type: answer.file.contentType, bytes: readFileSync(answer.file.path) } : answer?.status;
    };
    expect(await served("shots/screen.png")).toEqual({ type: "image/png", bytes: Buffer.from([137, 80, 78, 71]) });
    expect((await served("mockup.html") as { type: string }).type).toBe("text/plain; charset=utf-8");
    expect((await served("flow.svg") as { type: string }).type).toBe("text/plain; charset=utf-8");
    expect((await served("spec.pdf") as { type: string }).type).toBe("application/octet-stream");
    // Only the shared picture list is served as a picture (the window draws the same list): a BMP is a download.
    expect(PLAN_PICTURE_TYPES.map(artifactServedType)).toEqual([...PLAN_PICTURE_TYPES]);
    expect(artifactServedType("image/bmp")).toBe("application/octet-stream");
    expect(artifactServedType("Image/PNG; x=1")).toBe("image/png");
    // Only a recorded path: nothing else under files/, nothing outside it.
    expect(await served("nope.png")).toBe(404);
    expect(await served("..%2F..%2Fplan.jsonl")).toBe(404);
    expect(await served("shots%2F..%2Fmockup.html")).toBe(404);
    expect(store.artifactPath(plan.id, "../plan.jsonl")).toBeNull();
    expect(() => store.addArtifact(plan.id, { asset_path: "../x", bytes: new Uint8Array(), content_type: "text/plain", created_at: at })).toThrow();
    expect((await call("POST", `/api/plans/${plan.id}/files/mockup.html`))?.status).toBe(405);
  });
});
