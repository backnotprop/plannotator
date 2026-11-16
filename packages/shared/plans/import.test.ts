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
import { importPlanLibrary, importPlanLibraryInSteps, planImportSteps } from "./import";

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

  test("a file caught mid-write (truncated, then partly written) is left alone and imported whole on a later run", () => {
    const dataDir = scratch();
    const t = day(10).getTime();
    version(dataDir, "api", "steps-2026-11-10", 1, "# Steps\n\n1\n", day(9));
    const second = join(dataDir, "history", "api", "steps-2026-11-10", "002.md");
    const store = createPlanStore({ dataDir });

    // Plan review has truncated 002.md (0 bytes) and is about to write it.
    put(second, "", new Date(t));
    let report = importPlanLibrary(store, { dataDir, now: () => t + 100 });
    expect(report.unsettled).toEqual(["history/api/steps-2026-11-10/002.md"]);
    expect(store.list()[0]!.head_version_number).toBe(1);

    // Half the text is in.
    put(second, "# Steps\n\n", new Date(t + 200));
    report = importPlanLibrary(store, { dataDir, now: () => t + 300 });
    expect(report).toMatchObject({ versions_added: 0, unsettled: ["history/api/steps-2026-11-10/002.md"] });

    // The write finished (in place: the folder's time does not change). A later run takes the whole text, once.
    put(second, "# Steps\n\n2, written whole\n", new Date(t + 400));
    report = importPlanLibrary(store, { dataDir, now: () => t + 5000 });
    expect(report).toMatchObject({ versions_added: 1, unsettled: [] });
    const [plan] = store.list();
    expect(plan!.head_version_number).toBe(2);
    expect(new TextDecoder().decode(store.versionBytes(plan!.id, plan!.primary_doc_id, 2)!)).toBe("# Steps\n\n2, written whole\n");
    expect(importPlanLibrary(store, { dataDir, now: () => t + 9000 })).toMatchObject({ versions_added: 0 });
  });

  test("a decision snapshot caught mid-write makes no plan of its own; written whole, it lands on its version", () => {
    const dataDir = scratch();
    const t = day(10).getTime();
    version(dataDir, "api", "cache-2026-11-10", 1, "# Cache\n\nv1\n", day(9));
    const snapshot = join(dataDir, "plans", "cache-2026-11-10-approved.md");
    put(snapshot, "# Cac", new Date(t));
    const store = createPlanStore({ dataDir });
    const first = importPlanLibrary(store, { dataDir, now: () => t + 100 });
    expect(first).toMatchObject({ snapshot_only_plans: 0, decisions_added: 0, unsettled: ["plans/cache-2026-11-10-approved.md"] });

    put(snapshot, "# Cache\n\nv1\n" + "\n\n---\n\n" + "Fine.", new Date(t + 200));
    const next = importPlanLibrary(store, { dataDir, now: () => t + 5000 });
    expect(next).toMatchObject({ snapshot_only_plans: 0, decisions_added: 1 });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.decision).toMatchObject({ decision: "approved", version_number: 1 });
  });

  test("a feedback line with nothing to land on waits without the file being read again; it lands once its version is in", () => {
    const dataDir = scratch();
    const t = day(10).getTime();
    version(dataDir, "api", "plan-2026-11-10", 1, "# Plan\n\n1\n", day(9));
    // 002.md is still being written when its decision is already in the archive (a removed chain's line too).
    version(dataDir, "api", "plan-2026-11-10", 2, "# Plan\n\n2\n", new Date(t));
    const index = join(dataDir, "feedback", "api", "index.jsonl");
    const lines = [
      feedbackLine({ ts: day(9, 1).toISOString(), project: "api", surface: "plan", decision: "approved", target: { slug: "removed-2026-10-01", planVersion: 1 } }),
      feedbackLine({ ts: new Date(t + 50).toISOString(), project: "api", surface: "plan", decision: "denied", target: { slug: "plan-2026-11-10", planVersion: 2 }, feedback: "No." }),
    ];
    put(index, `${lines.join("\n")}\n`, new Date(t + 50));
    const store = createPlanStore({ dataDir });
    expect(importPlanLibrary(store, { dataDir, now: () => t + 100 })).toMatchObject({ decisions_added: 0, orphan_feedback: 2 });

    // Nothing changed: the waiting lines are not read again (before, every run read the whole file).
    expect(importPlanLibrary(store, { dataDir, now: () => t + 200 })).toMatchObject({ decisions_added: 0, orphan_feedback: 0 });

    // 002.md is now in: the waiting line lands on v2 (not on no version); the removed chain's line still waits.
    const settled = importPlanLibrary(store, { dataDir, now: () => t + 5000 });
    expect(settled).toMatchObject({ versions_added: 1, decisions_added: 1, orphan_feedback: 1 });
    const [plan] = store.list();
    expect(plan!.decision).toMatchObject({ decision: "denied", version_number: 2 });
    expect(store.read(plan!.id)!.events[0]!.decision!.version).toBe(store.versions(plan!.id)[1]!.version);

    // A new line is read alone; the waiting one is not tried again (no version was added).
    writeFileSync(index, `${readFileSync(index, "utf8")}${feedbackLine({ ts: day(11).toISOString(), project: "api", surface: "plan", decision: "approved", target: { slug: "plan-2026-11-10", planVersion: 2 } })}\n`);
    expect(importPlanLibrary(store, { dataDir, now: () => t + 9000 })).toMatchObject({ decisions_added: 1, orphan_feedback: 0 });
    expect(store.read(plan!.id)!.events.map((e) => e.decision!.decision)).toEqual(["denied", "approved"]);
  });

  for (const step of ["addVersion", "addEvent"] as const) {
    test(`a crash before ${step} of a decision without history: the next run finishes that plan, with no second one`, () => {
      const dataDir = scratch();
      put(join(dataDir, "plans", "ghost-plan-2026-11-03-approved.md"), "# Ghost plan\n\nno history\n", day(3, 20));
      const store = createPlanStore({ dataDir });
      const crashing: PlanStore = {
        ...store,
        [step]: () => {
          throw new Error("crash");
        },
      };
      expect(() => importPlanLibrary(crashing, { dataDir })).toThrow("crash");

      const report = importPlanLibrary(store, { dataDir });
      expect(report).toMatchObject({ plans_created: 0, decisions_added: 1 });
      const plans = store.list();
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ name: "Ghost plan", head_version_number: 1, decision: { decision: "approved", version_number: 1 } });
      expect(importPlanLibrary(store, { dataDir })).toMatchObject({ plans_created: 0, versions_added: 0, decisions_added: 0 });
      rmSync(join(planLibraryDir(dataDir), "legacy-map.json"));
      expect(importPlanLibrary(store, { dataDir })).toMatchObject({ plans_created: 0, versions_added: 0, decisions_added: 0 });
      expect(store.list()).toHaveLength(1);
    });
  }

  test("a long feedback archive is taken in many steps, not one", () => {
    const dataDir = scratch();
    version(dataDir, "api", "plan-2026-11-01", 1, "# Plan\n\n1\n", day(1));
    const lines = Array.from({ length: 100 }, (_, i) =>
      feedbackLine({ ts: day(2, 0).toISOString().replace("00:00:00", `00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`), project: "api", surface: "plan", decision: "feedback", target: { slug: "plan-2026-11-01", planVersion: 1 }, feedback: `note ${i}` }),
    );
    put(join(dataDir, "feedback", "api", "index.jsonl"), `${lines.join("\n")}\n`, day(2));
    const store = createPlanStore({ dataDir });
    const steps = planImportSteps(store, { dataDir });
    let pauses = 0;
    for (let next = steps.next(); !next.done; next = steps.next()) pauses++;
    // One chain, one feedback file: two steps without pauses inside; 100 lines at 25 a step make at least four more.
    expect(pauses).toBeGreaterThanOrEqual(6);
    expect(store.read(store.list()[0]!.id)!.events).toHaveLength(100);
  });

  test("no history, snapshots or feedback: nothing to import, and nothing written", () => {
    const dataDir = scratch();
    const store = createPlanStore({ dataDir });
    const report = importPlanLibrary(store, { dataDir });
    expect(report).toMatchObject({ plans_created: 0, versions_added: 0, decisions_added: 0 });
    expect(readdirSync(dataDir)).toEqual([]);
  });
});
