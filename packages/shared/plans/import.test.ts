/**
 * The plan library's import from today's stores, on a scratch data dir laid out as plan review lays it out
 * (`history/{project}/{slug}/NNN.md`, `plans/{slug}-approved.md`, `feedback/{project}/index.jsonl`). What regresses
 * if these fail:
 * - a chain does not become one plan with its versions in order, dated by its files;
 * - a split chain is joined (or two projects' same slug merged), or missing numbers leave a gap or lose a version;
 * - a decision is lost, lands on the wrong version, is kept twice (feedback line and snapshot), or a decision
 *   without history disappears;
 * - running it again (or after its map is lost) adds anything twice;
 * - a source file is changed, moved or created by the import;
 * - a new version plan review writes later is not picked up, or an unreadable file breaks the order.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createPlanStore, planLibraryDir, type PlanStore } from "./store";
import { importPlanLibrary, importPlanLibraryInSteps } from "./import";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "plans-import-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

const day = (d: number, hour = 9) => new Date(Date.UTC(2026, 10, d, hour));

function put(path: string, text: string, when: Date) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, when, when);
}

const version = (dataDir: string, project: string, slug: string, n: number, text: string, when: Date) =>
  put(join(dataDir, "history", project, slug, `${String(n).padStart(3, "0")}.md`), text, when);

const feedbackLine = (record: Record<string, unknown>) =>
  JSON.stringify({ v: 1, client: "plannotator", counts: { annotations: 0, external: 0, images: 0 }, ...record });

/** The fixture: every odd case the import names. */
function fixture() {
  const dataDir = scratch();
  // 1. One chain, three versions; its heading changes in v3.
  version(dataDir, "api", "auth-refactor-2026-11-01", 1, "# Auth refactor\n\nv1\n", day(1));
  version(dataDir, "api", "auth-refactor-2026-11-01", 2, "# Auth refactor\n\nv2\n", day(1, 12));
  version(dataDir, "api", "auth-refactor-2026-11-01", 3, "# Auth refactor\n\nv3\n", day(2));
  // 2. Split: the heading changed (a new slug), and the same heading after two quiet days (a new dated slug).
  version(dataDir, "api", "auth-rewrite-2026-11-02", 1, "# Auth rewrite\n\nnew heading\n", day(2, 15));
  version(dataDir, "api", "auth-refactor-2026-11-06", 1, "# Auth refactor\n\nagain, later\n", day(6));
  // 3. Missing numbers: 001, 002, 004.
  version(dataDir, "api", "cache-layer-2026-11-03", 1, "# Cache layer\n\none\n", day(3));
  version(dataDir, "api", "cache-layer-2026-11-03", 2, "# Cache layer\n\ntwo\n", day(3, 10));
  version(dataDir, "api", "cache-layer-2026-11-03", 4, "# Cache layer\n\nfour\n", day(3, 11));
  // 5. Two projects, the same slug.
  version(dataDir, "web", "auth-refactor-2026-11-01", 1, "# Auth refactor\n\nthe web one\n", day(1, 8));
  // Not plans: annotate's chain, an empty folder, a submissions folder and a stray file.
  version(dataDir, "api", "annotate-readme-md-1a2b3c4d", 1, "# README\n", day(4));
  mkdirSync(join(dataDir, "history", "api", "interrupted-2026-11-04"), { recursive: true });
  put(join(dataDir, "history", "api", "auth-refactor-2026-11-01", "submissions", "x.md"), "not a version", day(2));
  put(join(dataDir, "history", "api", "auth-refactor-2026-11-01", "notes.txt"), "stray", day(2));

  // 6. Feedback: approved on chain 1 v3 (with notes), denied on v2, an annotate line, a torn line, an orphan.
  const fb = [
    feedbackLine({ ts: day(1, 13).toISOString(), project: "api", surface: "plan", decision: "denied", target: { slug: "auth-refactor-2026-11-01", planVersion: 2 }, feedback: "Split the token step." }),
    feedbackLine({ ts: day(2, 1).toISOString(), project: "api", surface: "plan", decision: "approved-with-notes", target: { slug: "auth-refactor-2026-11-01", planVersion: 3 }, feedback: "Ship it." }),
    feedbackLine({ ts: day(4).toISOString(), project: "api", surface: "annotate", decision: "feedback", target: { filePath: "/x/README.md" } }),
    feedbackLine({ ts: day(5).toISOString(), project: "api", surface: "plan", decision: "approved", target: { slug: "deleted-plan-2026-10-01", planVersion: 1 } }),
    '{"v":1,"ts":"2026-11-05T',
  ];
  put(join(dataDir, "feedback", "api", "index.jsonl"), `${fb.join("\n")}\n`, day(5));

  // 7. Snapshots: approved v3 of chain 1 (a duplicate of the feedback line); denied on the renamed plan (no line);
  // and 4. a decision without history.
  // As saveFinalSnapshot writes it: the plan, "\n\n---\n\n", the notes.
  put(join(dataDir, "plans", "auth-refactor-2026-11-02-approved.md"), "# Auth refactor\n\nv3\n" + "\n\n---\n\n" + "Ship it.", day(2, 1));
  put(join(dataDir, "plans", "auth-rewrite-2026-11-02-denied.md"), "# Auth rewrite\n\nnew heading\n", day(2, 16));
  put(join(dataDir, "plans", "ghost-plan-2026-11-03-approved.md"), "# Ghost plan\n\nno history\n", day(3, 20));
  put(join(dataDir, "plans", "auth-refactor-2026-11-02.annotations.md"), "not a decision", day(2));
  put(join(dataDir, "plans", "plain-2026-11-02.md"), "not a decision", day(2));
  return { dataDir, store: createPlanStore({ dataDir }) };
}

/** Every file under `dir` (relative path → bytes and modified time), to prove nothing changed. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.set(relative(dir, path), `${statSync(path).mtimeMs}:${readFileSync(path, "base64")}`);
    }
  };
  walk(dir);
  return out;
}

const sources = (dataDir: string) => new Map([...tree(dataDir)].filter(([path]) => !path.startsWith("plan-library")));
const byName = (store: PlanStore) => store.list().map((p) => ({ ...p, read: store.read(p.id)! }));

describe("plan import", () => {
  test("each chain is one plan; split chains and same-slug projects stay apart; odd files are left out", () => {
    const { dataDir, store } = fixture();
    const report = importPlanLibrary(store, { dataDir });

    const plans = byName(store);
    const names = plans.map((p) => `${p.project_name ?? "-"}/${p.name}/v${p.head_version_number}`).sort();
    expect(names).toEqual(["-/Ghost plan/v1", "api/Auth refactor/v1", "api/Auth refactor/v3", "api/Auth rewrite/v1", "api/Cache layer/v3", "web/Auth refactor/v1"]);
    expect(report).toMatchObject({ plans_created: 6, versions_added: 10, annotate_chains: 1, empty_chains: 1, snapshot_only_plans: 1, orphan_feedback: 1, unreadable: [] });
    expect(report.gaps).toEqual(["api/cache-layer-2026-11-03"]);

    // Chain 1: versions in order, dated by their files, each naming its source file; bytes as written.
    const chain = plans.find((p) => p.read.plan.legacy?.chains[0]?.slug === "auth-refactor-2026-11-01" && p.project_name === "api")!;
    expect(chain.read.versions.map((v) => [v.version_number, v.committed_at, v.legacy])).toEqual([
      [1, day(1).toISOString(), "history/api/auth-refactor-2026-11-01/001.md"],
      [2, day(1, 12).toISOString(), "history/api/auth-refactor-2026-11-01/002.md"],
      [3, day(2).toISOString(), "history/api/auth-refactor-2026-11-01/003.md"],
    ]);
    expect(new TextDecoder().decode(store.versionBytes(chain.id, chain.primary_doc_id, 2)!)).toBe("# Auth refactor\n\nv2\n");
    expect(chain.created_at).toBe(day(1).toISOString());

    // Missing numbers: 1, 2, 3 with no gap; the third is 004.md.
    const cache = plans.find((p) => p.name === "Cache layer")!;
    expect(cache.read.versions.map((v) => [v.version_number, v.legacy?.split("/").pop()])).toEqual([[1, "001.md"], [2, "002.md"], [3, "004.md"]]);
  });

  test("decisions land on the version they name; a decision kept as both a line and a snapshot is kept once", () => {
    const { dataDir, store } = fixture();
    const report = importPlanLibrary(store, { dataDir });
    const plans = byName(store);
    const chain = plans.find((p) => p.read.plan.legacy?.chains[0]?.slug === "auth-refactor-2026-11-01" && p.project_name === "api")!;
    const decisions = chain.read.events.map((e) => [e.decision!.decision, e.decision!.version_number, e.decision!.feedback, e.decision!.feedback_record?.file ?? e.decision!.snapshot]);
    expect(decisions).toEqual([
      ["denied", 2, "Split the token step.", "feedback/api/index.jsonl"],
      ["approved-with-notes", 3, "Ship it.", "feedback/api/index.jsonl"],
    ]);
    expect(chain.decision).toMatchObject({ decision: "approved-with-notes", version_number: 3 });
    expect(report.duplicate_snapshots).toBe(1);

    // A snapshot with no feedback line: matched to the renamed plan's v1 by its text.
    const rewrite = plans.find((p) => p.name === "Auth rewrite")!;
    expect(rewrite.read.events.map((e) => [e.decision!.decision, e.decision!.version_number, e.decision!.snapshot])).toEqual([["denied", 1, "plans/auth-rewrite-2026-11-02-denied.md"]]);

    // A decision without history: a plan of its own, the snapshot as its one version, no project.
    const ghost = plans.find((p) => p.name === "Ghost plan")!;
    expect(ghost.project_name).toBeNull();
    expect(ghost.read.versions.map((v) => v.legacy)).toEqual(["plans/ghost-plan-2026-11-03-approved.md"]);
    expect(ghost.read.events.map((e) => [e.decision!.decision, e.decision!.version_number])).toEqual([["approved", 1]]);
    expect(report.decisions_added).toBe(4);
  });

  test("source files are byte-identical after the import, and no file appears outside plan-library", () => {
    const { dataDir, store } = fixture();
    const before = sources(dataDir);
    importPlanLibrary(store, { dataDir });
    importPlanLibrary(store, { dataDir });
    expect(sources(dataDir)).toEqual(before);
  });

  test("running it again adds nothing; nor does running it after its map is lost", async () => {
    const { dataDir, store } = fixture();
    importPlanLibrary(store, { dataDir });
    const library = () => new Map([...tree(planLibraryDir(dataDir))].filter(([path]) => path !== "legacy-map.json"));
    const after = library();
    const again = importPlanLibrary(store, { dataDir, repair: true });
    expect(again).toMatchObject({ plans_created: 0, versions_added: 0, decisions_added: 0, index_repaired: 0 });
    expect(library()).toEqual(after);

    rmSync(join(planLibraryDir(dataDir), "legacy-map.json"));
    const lost = await importPlanLibraryInSteps(store, { dataDir });
    expect(lost).toMatchObject({ plans_created: 0, versions_added: 0, decisions_added: 0 });
    expect(library()).toEqual(after);
    expect(store.list()).toHaveLength(6);
  });

  test("a version plan review writes later is picked up as the plan's next version, its heading the plan's name", () => {
    const { dataDir, store } = fixture();
    importPlanLibrary(store, { dataDir });
    version(dataDir, "api", "auth-refactor-2026-11-01", 4, "# Auth refactor, smaller\n\nv4\n", day(7));
    // Plan review's next decision on it.
    const index = join(dataDir, "feedback", "api", "index.jsonl");
    writeFileSync(index, `${readFileSync(index, "utf8")}${feedbackLine({ ts: day(7, 1).toISOString(), project: "api", surface: "plan", decision: "approved", target: { slug: "auth-refactor-2026-11-01", planVersion: 4 } })}\n`);
    const report = importPlanLibrary(store, { dataDir });
    expect(report).toMatchObject({ plans_created: 0, versions_added: 1, decisions_added: 1 });
    const plan = store.list().find((p) => p.name === "Auth refactor, smaller")!;
    expect(plan).toMatchObject({ head_version_number: 4, decision: { decision: "approved", version_number: 4 } });
    expect(importPlanLibrary(store, { dataDir })).toMatchObject({ versions_added: 0, decisions_added: 0 });
  });

  test("an unreadable version stops its chain there; the next run goes on from it, in order", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const dataDir = scratch();
    version(dataDir, "api", "steps-2026-11-01", 1, "# Steps\n\n1\n", day(1));
    version(dataDir, "api", "steps-2026-11-01", 2, "# Steps\n\n2\n", day(1, 10));
    version(dataDir, "api", "steps-2026-11-01", 3, "# Steps\n\n3\n", day(1, 11));
    const second = join(dataDir, "history", "api", "steps-2026-11-01", "002.md");
    chmodSync(second, 0o000);
    const store = createPlanStore({ dataDir });
    const first = importPlanLibrary(store, { dataDir });
    expect(first.unreadable).toEqual(["history/api/steps-2026-11-01/002.md"]);
    expect(store.list()[0]!.head_version_number).toBe(1);
    chmodSync(second, 0o600);
    const next = importPlanLibrary(store, { dataDir });
    expect(next).toMatchObject({ plans_created: 0, versions_added: 2, unreadable: [] });
    const [plan] = store.list();
    expect(store.versions(plan!.id).map((v) => v.legacy?.split("/").pop())).toEqual(["001.md", "002.md", "003.md"]);
  });

  test("no history, snapshots or feedback: nothing to import, and nothing written", () => {
    const dataDir = scratch();
    const store = createPlanStore({ dataDir });
    const report = importPlanLibrary(store, { dataDir });
    expect(report).toMatchObject({ plans_created: 0, versions_added: 0, decisions_added: 0 });
    expect(readdirSync(dataDir)).toEqual([]);
  });
});
