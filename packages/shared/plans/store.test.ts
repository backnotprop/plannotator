/**
 * The plan library on disk, on a scratch data dir. What regresses if these fail:
 * - a plan, its versions or its decisions do not read back as written, or the list loses or misorders a plan;
 * - a version stops being a plain file a person can open without Plannotator;
 * - "changed since you looked" is wrong after a new version;
 * - a crash mid-write (a torn line, a version file with no line, a line with no document update, a plan record never
 *   written) loses data, reuses a version number, glues two lines together or duplicates a document;
 * - the library is readable by other users of the machine (0700 folders, 0600 files);
 * - opening the store writes anything.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitBlobSha, planId } from "@plannotator/core/plans";
import { createPlanStore, planLibraryDir } from "./store";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-store-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);
const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9)).toISOString();

function world() {
  const dataDir = scratch();
  const store = createPlanStore({ dataDir });
  const { plan, document } = store.createPlan({ name: "Auth refactor", project_name: "api", created_at: at(1), document: { title: "Auth refactor" } });
  return { dataDir, store, plan, doc: document.id };
}

describe("plan store", () => {
  test("opening the store reads and writes nothing", () => {
    const dataDir = scratch();
    const store = createPlanStore({ dataDir });
    expect(store.exists()).toBe(false);
    expect(store.list()).toEqual([]);
    expect(store.looks()).toEqual({ v: 1, plans: {} });
    expect(store.legacyMap().chains).toEqual({});
    expect(existsSync(planLibraryDir(dataDir))).toBe(false);
  });

  test("a plan, its versions and a decision read back; versions are plain files", () => {
    const { dataDir, store, plan, doc } = world();
    const v1 = store.addVersion(plan.id, doc, { bytes: bytes("# Auth refactor\n\nv1\n"), committed_at: at(2), source: "plan-review" });
    const v2 = store.addVersion(plan.id, doc, { bytes: bytes("# Auth refactor\n\nv2\n"), committed_at: at(3), source: "plan-review", agent_host: "claude-code" });
    store.addEvent(plan.id, {
      kind: "decision",
      at: at(4),
      author_label: null,
      author_via: "plan-review",
      agent_host: null,
      agent_session: null,
      agent_name: null,
      subject: { document_id: doc, version_number: 2 },
      decision: { document_id: doc, version: v2.version, version_number: 2, decision: "approved", at: at(4), feedback: null, feedback_record: null, snapshot: null },
      legacy: null,
    });

    expect([v1.version_number, v2.version_number]).toEqual([1, 2]);
    expect(v2.version).toBe(gitBlobSha("# Auth refactor\n\nv2\n"));
    expect(v2.agent_host).toBe("claude-code");
    // The file is where the record says, byte for byte, under the plan's own folder.
    const file = join(planLibraryDir(dataDir), plan.id, v2.file);
    expect(v2.file).toBe(`docs/${doc}/2.md`);
    expect(readFileSync(file, "utf8")).toBe("# Auth refactor\n\nv2\n");
    expect(new TextDecoder().decode(store.versionBytes(plan.id, doc, 1)!)).toBe("# Auth refactor\n\nv1\n");
    expect(store.versionBytes(plan.id, doc, 3)).toBeNull();

    const read = store.read(plan.id)!;
    expect(read.plan.name).toBe("Auth refactor");
    expect(read.documents.map((d) => [d.id, d.head_version])).toEqual([[doc, 2]]);
    expect(read.events.map((e) => e.decision?.decision)).toEqual(["approved"]);

    const [listed] = store.list();
    expect(listed).toMatchObject({ id: plan.id, project_name: "api", head_version_number: 2, updated_at: at(4), decision: { decision: "approved", version_number: 2 } });
    expect(listed!.counts).toMatchObject({ documents: 1, versions: 2, events: 1 });
    expect(listed!.changed).toBe(false);
    expect(listed!.seen_version_number).toBeNull();
  });

  test("the list is newest change first, the last index line per plan winning", () => {
    const dataDir = scratch();
    const store = createPlanStore({ dataDir });
    const a = store.createPlan({ name: "A", created_at: at(1), document: { title: "A" } });
    const b = store.createPlan({ name: "B", created_at: at(2), document: { title: "B" } });
    expect(store.list().map((p) => p.name)).toEqual(["B", "A"]);
    store.addVersion(a.plan.id, a.document.id, { bytes: bytes("# A"), committed_at: at(5), source: "plan-review" });
    expect(store.list().map((p) => p.name)).toEqual(["A", "B"]);
    store.updatePlan(b.plan.id, { name: "B renamed" }, at(6));
    expect(store.list().map((p) => p.name)).toEqual(["B renamed", "A"]);
    expect(store.list()).toHaveLength(2);
  });

  test("a look records the seen version; a newer version marks the plan changed", () => {
    const { store, plan, doc } = world();
    store.addVersion(plan.id, doc, { bytes: bytes("one"), committed_at: at(2), source: "plan-review" });
    store.addVersion(plan.id, doc, { bytes: bytes("two"), committed_at: at(3), source: "plan-review" });
    store.recordLook(plan.id, { seen: 2, at: at(4) });
    expect(store.list()[0]).toMatchObject({ seen_version_number: 2, looked_at: at(4), changed: false });
    store.addVersion(plan.id, doc, { bytes: bytes("three"), committed_at: at(5), source: "agent-tool" });
    expect(store.list()[0]).toMatchObject({ head_version_number: 3, seen_version_number: 2, changed: true });
    // A look never moves "seen" backwards.
    store.recordLook(plan.id, { seen: 1 });
    expect(store.looks().plans[plan.id]!.docs[doc]).toBe(2);
    expect(() => store.recordLook(planId("pln"))).toThrow();
  });

  test("folders are 0700 and files 0600", () => {
    const { dataDir, store, plan, doc } = world();
    store.addVersion(plan.id, doc, { bytes: bytes("v1"), committed_at: at(2), source: "plan-review" });
    store.recordLook(plan.id, {});
    store.saveLegacyMap(store.legacyMap());
    const root = planLibraryDir(dataDir);
    const mode = (path: string) => statSync(path).mode & 0o777;
    if (process.platform === "win32") return;
    for (const folder of [root, join(root, plan.id), join(root, plan.id, "docs", doc)]) expect([folder, mode(folder)]).toEqual([folder, 0o700]);
    for (const file of [join(root, "index.jsonl"), join(root, "looks.json"), join(root, "legacy-map.json"), join(root, plan.id, "plan.jsonl"), join(root, plan.id, "docs.jsonl"), join(root, plan.id, "docs", doc, "1.md")]) {
      expect([file, mode(file)]).toEqual([file, 0o600]);
    }
  });
});

describe("plan store: crash safety", () => {
  test("a torn last line is skipped, and the next line starts on its own", () => {
    const { dataDir, store, plan, doc } = world();
    store.addVersion(plan.id, doc, { bytes: bytes("v1"), committed_at: at(2), source: "plan-review" });
    const docs = join(planLibraryDir(dataDir), plan.id, "docs.jsonl");
    appendFileSync(docs, '{"kind":"version","record":{"version":"ab');
    expect(store.versions(plan.id).map((v) => v.version_number)).toEqual([1]);
    store.addVersion(plan.id, doc, { bytes: bytes("v2"), committed_at: at(3), source: "plan-review" });
    expect(store.versions(plan.id).map((v) => v.version_number)).toEqual([1, 2]);
    const lines = readFileSync(docs, "utf8").split("\n");
    expect(lines.filter((line) => line.startsWith('{"kind":"version","record":{"version":"ab'))).toEqual(['{"kind":"version","record":{"version":"ab']);
  });

  test("a version file with no line is never read, and the next version writes over it", () => {
    const { dataDir, store, plan, doc } = world();
    store.addVersion(plan.id, doc, { bytes: bytes("v1"), committed_at: at(2), source: "plan-review" });
    const orphan = join(planLibraryDir(dataDir), plan.id, "docs", doc, "2.md");
    writeFileSync(orphan, "half-written");
    expect(store.versions(plan.id)).toHaveLength(1);
    expect(store.versionBytes(plan.id, doc, 2)).toBeNull();
    const v2 = store.addVersion(plan.id, doc, { bytes: bytes("the real v2"), committed_at: at(3), source: "plan-review" });
    expect(v2.version_number).toBe(2);
    expect(readFileSync(orphan, "utf8")).toBe("the real v2");
    expect(v2.version).toBe(gitBlobSha("the real v2"));
  });

  test("a version line whose document update was lost: the next version takes the next number", () => {
    const { dataDir, store, plan, doc } = world();
    store.addVersion(plan.id, doc, { bytes: bytes("v1"), committed_at: at(2), source: "plan-review" });
    store.addVersion(plan.id, doc, { bytes: bytes("v2"), committed_at: at(3), source: "plan-review" });
    const docs = join(planLibraryDir(dataDir), plan.id, "docs.jsonl");
    const lines = readFileSync(docs, "utf8").trimEnd().split("\n");
    writeFileSync(docs, `${lines.slice(0, -1).join("\n")}\n`); // drop the last document line (head 2)
    expect(store.read(plan.id)!.documents[0]!.head_version).toBe(2);
    const v3 = store.addVersion(plan.id, doc, { bytes: bytes("v3"), committed_at: at(4), source: "plan-review" });
    expect(v3.version_number).toBe(3);
    expect(new TextDecoder().decode(store.versionBytes(plan.id, doc, 2)!)).toBe("v2");
  });

  test("a plan whose record was never written keeps its document when it is created again", () => {
    const dataDir = scratch();
    const store = createPlanStore({ dataDir });
    const id = planId("pln");
    const first = store.createPlan({ id, name: "P", created_at: at(1), document: { title: "P" } });
    rmSync(join(planLibraryDir(dataDir), id, "plan.jsonl")); // the crash: document line written, record not
    expect(store.get(id)).toBeNull();
    const again = store.createPlan({ id, name: "P", created_at: at(1), document: { title: "P" } });
    expect(again.document.id).toBe(first.document.id);
    expect(store.read(id)!.documents).toHaveLength(1);
    expect(() => store.createPlan({ id, name: "P", created_at: at(1), document: { title: "P" } })).toThrow();
  });

  test("leftover temp files are ignored, and an index line a crash lost is written again", () => {
    const { dataDir, store, plan, doc } = world();
    store.addVersion(plan.id, doc, { bytes: bytes("v1"), committed_at: at(2), source: "plan-review" });
    const root = planLibraryDir(dataDir);
    writeFileSync(join(root, "looks.json.123.abc.tmp"), "{");
    writeFileSync(join(root, "index.jsonl"), ""); // every index line lost
    expect(store.list()).toEqual([]);
    expect(store.looks()).toEqual({ v: 1, plans: {} });
    expect(store.repairIndex()).toBe(1);
    expect(store.list().map((p) => [p.id, p.head_version_number])).toEqual([[plan.id, 1]]);
    expect(store.repairIndex()).toBe(0);
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual(["looks.json.123.abc.tmp"]);
  });
});
