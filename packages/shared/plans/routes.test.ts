/**
 * Plans' routes, in process through the runtime-neutral handler (no server), on a scratch data dir. What regresses
 * if these fail:
 * - the list, a plan, its versions or one version's bytes cannot be read, or another document's are served;
 * - the diff gets the wrong pair (it must start from the version the person last saw);
 * - a look records a version that does not exist, takes a bad body, or answers a GET;
 * - a path that is not a plan id, or a malformed one, crashes instead of answering 4xx.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planId } from "@plannotator/core/plans";
import { createPlanStore } from "./store";
import { handlePlanRoute, isPlansPath, type PlanRouteResult } from "./routes";

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

  test("not a plan, an unknown plan, an unknown path or bad encoding answer 4xx", async () => {
    const { plan, call } = world();
    expect((await call("GET", "/api/plans/shp_1"))?.status).toBe(404);
    expect((await call("GET", `/api/plans/${planId("pln")}`))?.status).toBe(404);
    expect((await call("GET", `/api/plans/${plan.id}/nope`))?.status).toBe(404);
    expect((await call("GET", "/api/plans/%E0%A4%A"))?.status).toBe(400);
  });
});
