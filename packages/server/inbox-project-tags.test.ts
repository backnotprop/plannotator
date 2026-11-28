/**
 * The project tags' route and the merged list's far projects (inbox-project-tags.ts), and the door's way to them.
 *
 * The failures this guards: a write by the tag's name that does not reach the store, a stale page's write taken, a far
 * project whose tags keep that machine's ids (so no filter matches them) or keep tags from a machine that takes none
 * from here, and a linked machine's write that the forward would not carry or hold.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxProjectTags } from "@plannotator/shared/inbox/project-tags";
import { createInboxProjectTagsRoute, farProjectTags } from "./inbox-project-tags";
import { doorWriteKind } from "./inbox-outbox";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-project-tags-route-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "billing-svc", root: "/work/billing-svc" });
  const work = store.createInitiative({ name: "Work", by: { kind: "person" } });
  const tags = createInboxProjectTags(store);
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const route = createInboxProjectTagsRoute({ tags, serverSession: "page-1", readBody: async (req) => (await req.json()) as Record<string, unknown>, json });
  const post = (path: string, body: Record<string, unknown>) => route(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }), new URL(`http://localhost${path}`));
  return { store, project, work, tags, route, post };
}

test("the route tags a project by id or by name, and answers its tags", async () => {
  const { project, work, tags, store, post } = world();
  const byId = await post(`/api/inbox/projects/${project.id}/tags`, { tag: work.id, on: true, serverSession: "page-1" });
  expect(await byId!.json()).toEqual({ tags: [work.id] });
  const byName = await post(`/api/inbox/projects/${project.id}/tags`, { name: "Personal", on: true });
  const made = store.initiatives().find((tag) => tag.name === "Personal")!;
  expect(await byName!.json()).toEqual({ tags: [work.id, made.id] });
  expect(tags.tagsOf(project.id)).toEqual([work.id, made.id]);
});

test("a stale page's write is refused and changes nothing; other paths are not this route", async () => {
  const { project, work, tags, route, post } = world();
  const stale = await post(`/api/inbox/projects/${project.id}/tags`, { tag: work.id, on: true, serverSession: "page-0" });
  expect(stale!.status).toBe(409);
  expect(tags.tagsOf(project.id)).toEqual([]);
  expect(await route(new Request("http://localhost/x"), new URL(`http://localhost/api/inbox/projects/${project.id}/name`))).toBeNull();
});

test("a far project's tags read as the merged tags of their names, none from a machine that takes no tags", () => {
  const idOn = (machine: string, id: string) => (machine === "ibx_mac" && id === "ini_mac_work" ? "ini_here_work" : null);
  const far = { id: "prj_far", name: "site", machine: "ibx_mac", tags: ["ini_mac_work", "ini_mac_gone"] };
  expect(farProjectTags(far, new Set(["ibx_mac"]), idOn)).toEqual({ id: "prj_far", name: "site", machine: "ibx_mac", tags: ["ini_here_work"] });
  expect(farProjectTags(far, new Set(), idOn)).toEqual({ id: "prj_far", name: "site", machine: "ibx_mac" });
  expect(farProjectTags({ id: "prj_old", machine: "ibx_mac" }, new Set(["ibx_mac"]), idOn)).toEqual({ id: "prj_old", machine: "ibx_mac" });
});

test("a linked machine's project tag write is held in the outbox as a set, as a thread's tag is", () => {
  expect(doorWriteKind("projects/prj_01ABC/tags")).toBe("set");
  expect(doorWriteKind("threads/msg_01ABC/tags")).toBe("set");
});
