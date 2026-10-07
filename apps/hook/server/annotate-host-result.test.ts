/**
 * `plannotator annotate` run as the real process with the Claude Code mod's
 * host result file: what the editor posts for a Done with nothing to send must
 * be a no-op for the host record (no agent turn), while stdout and `--json`
 * stay exactly what every other caller has always read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "index.ts");
const distDir = resolve(import.meta.dir, "../dist");
const roots: string[] = [];
let stubs: string[] = [];

// The editor's zero-state payload (ANNOTATE_NO_FEEDBACK_SENTENCE); the CLI
// prints it verbatim, which is the established stdout contract pinned here.
const NO_FEEDBACK = "User reviewed the document and has no feedback.";

beforeAll(() => {
  // The CLI imports the built HTML; API-only tests need just a stub.
  stubs = ["index.html", "review.html", "inbox.html"].map((name) => join(distDir, name)).filter((path) => !existsSync(path));
  mkdirSync(distDir, { recursive: true });
  for (const path of stubs) writeFileSync(path, "<!doctype html><title>test</title>");
});
afterAll(() => {
  for (const path of stubs) rmSync(path, { force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | null | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

function start(args: string[], setup: (root: string) => void, env: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-annotate-host-result-")));
  roots.push(root);
  setup(root);
  const launch = join(root, "data", "claude-code-mod", "session-1", "launch-1");
  mkdirSync(launch, { recursive: true });
  const files = { ready: join(launch, "ready"), result: join(launch, "result.json") };
  const proc = Bun.spawn([process.execPath, "run", entry, "annotate", ...args], {
    cwd: root,
    env: {
      ...process.env,
      PLANNOTATOR_DATA_DIR: join(root, "data"),
      PLANNOTATOR_PORT: "0",
      PLANNOTATOR_REMOTE: "0",
      PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
      PLANNOTATOR_READY_FILE: files.ready,
      PLANNOTATOR_HOST_RESULT_FILE: files.result,
      PLANNOTATOR_AI: "disabled",
      PLANNOTATOR_SHARE: "disabled",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const base = async () => {
    const line = await waitFor(() => (existsSync(files.ready) ? readFileSync(files.ready, "utf8").split("\n")[0] : null));
    return `http://localhost:${(JSON.parse(line) as { port: number }).port}`;
  };
  const finish = async () => {
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { code, stdout, record: JSON.parse(readFileSync(files.result, "utf8")) };
  };
  return { root, base, finish };
}

const note = (root: string) => writeFileSync(join(root, "notes.md"), "# Notes\n\nHello.\n");

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

// What the editor posts for Done with nothing to send.
const EMPTY_DONE = { feedback: NO_FEEDBACK, annotations: [], codeAnnotations: [], nothingToSend: true };

describe("annotate Done with nothing to send", () => {
  test("plain: stdout keeps the sentence, the host record is a no-op", async () => {
    const run = start(["notes.md"], note);
    await post(await run.base(), "/api/feedback", EMPTY_DONE);
    const { code, stdout, record } = await run.finish();
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(NO_FEEDBACK);
    expect(record).toMatchObject({ surface: "annotate", decision: "annotated", noop: true, message: "", annotationCount: 0 });
  }, 30_000);

  test("--json: stdout stays decision annotated with the sentence plus the additive fields, the host record is a no-op", async () => {
    const run = start(["notes.md", "--json"], note);
    await post(await run.base(), "/api/feedback", EMPTY_DONE);
    const { code, stdout, record } = await run.finish();
    expect(code).toBe(0);
    // Three additive fields: nothingToSend (#1701), annotationCount (the
    // OpenCode bridge's heading) and target (the file as the CLI resolved it,
    // which the bridge names instead of the words it passed).
    const printed = JSON.parse(stdout.trim());
    expect(printed).toEqual({ decision: "annotated", feedback: NO_FEEDBACK, nothingToSend: true, annotationCount: 0, target: expect.any(String) });
    expect(printed.target).toMatch(/\/notes\.md$/);
    expect(record.noop).toBe(true);
    expect(record.target).toBe(printed.target);
  }, 30_000);

  test("a flag next to annotations is ignored: feedback with comments still starts a turn", async () => {
    const run = start(["notes.md"], note);
    await post(await run.base(), "/api/feedback", {
      feedback: "1. tighten the intro",
      annotations: [{ id: "a1", type: "COMMENT", text: "tighten the intro", originalText: "Hello." }],
      nothingToSend: true,
    });
    const { record } = await run.finish();
    expect(record).toMatchObject({ decision: "annotated", noop: false, annotationCount: 1 });
    expect(record.message).toContain("tighten the intro");
  }, 30_000);
});

describe("annotate folder session", () => {
  test("every document's comments count, and the archive records which document each is on", async () => {
    let docs = "";
    const run = start(
      ["docs/"],
      (root) => {
        docs = join(root, "docs");
        mkdirSync(docs);
        writeFileSync(join(docs, "a.md"), "# A\n\nAlpha.\n");
        writeFileSync(join(docs, "b.md"), "# B\n\nBeta.\n");
      },
      { PLANNOTATOR_FEEDBACK_HISTORY: "1" },
    );
    await post(await run.base(), "/api/feedback", {
      feedback: "# Folder Feedback\n\n…two comments…",
      annotations: [
        { id: "a1", type: "COMMENT", text: "first", originalText: "Alpha.", documentPath: join(docs, "a.md") },
        { id: "b1", type: "COMMENT", text: "second", originalText: "Beta.", documentPath: join(docs, "b.md") },
      ],
    });
    const { record } = await run.finish();
    expect(record).toMatchObject({ decision: "annotated", noop: false, annotationCount: 2 });

    const feedbackRoot = join(run.root, "data", "feedback");
    const [project] = readdirSync(feedbackRoot);
    const line = JSON.parse(readFileSync(join(feedbackRoot, project!, "index.jsonl"), "utf8").trim());
    expect(line.surface).toBe("annotate-folder");
    expect(line.counts.annotations).toBe(2);
    expect(line.annotations.map((a: { documentPath?: string }) => a.documentPath)).toEqual([
      join(docs, "a.md"),
      join(docs, "b.md"),
    ]);
  }, 30_000);
});

// Two files can share a name (`QUESTIONS.md` in two release folders): the
// process names the file it resolved, in full, in the ready line, the
// sessions registry and the decision record, and `plannotator sessions`
// prints it with the host's pn- id.
describe("decision target", () => {
  test("ready line, registry, `sessions --json` and the record name the resolved file; the pn- id rides along", async () => {
    const nested = (root: string) => {
      mkdirSync(join(root, "releases-2026-10-04"), { recursive: true });
      writeFileSync(join(root, "releases-2026-10-04", "QUESTIONS.md"), "# Questions\n");
    };
    const run = start(["releases-2026-10-04/QUESTIONS.md"], nested, { PLANNOTATOR_HOST_REVIEW_ID: "pn-abc123" });
    const base = await run.base();
    const file = join(run.root, "releases-2026-10-04", "QUESTIONS.md");

    const readyLine = readFileSync(join(run.root, "data", "claude-code-mod", "session-1", "launch-1", "ready"), "utf8").split("\n")[0]!;
    expect(JSON.parse(readyLine).target).toBe(file);

    const listed = Bun.spawnSync([process.execPath, "run", entry, "sessions", "--json"], {
      cwd: run.root,
      env: { ...process.env, PLANNOTATOR_DATA_DIR: join(run.root, "data") },
    });
    const sessions = JSON.parse(listed.stdout.toString()) as { index: number; reviewId?: string; target?: string; url: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ index: 1, reviewId: "pn-abc123", target: file });
    expect(sessions[0]!.url).toContain(new URL(base).port);
    // The table names the full target too (stderr, as before).
    const table = Bun.spawnSync([process.execPath, "run", entry, "sessions"], {
      cwd: run.root,
      env: { ...process.env, PLANNOTATOR_DATA_DIR: join(run.root, "data") },
    });
    expect(table.stderr.toString()).toContain(file);
    expect(table.stderr.toString()).toContain("pn-abc123");

    await post(base, "/api/feedback", { feedback: "Answer Q2 first.", annotations: [{ id: "a" }] });
    const { record } = await run.finish();
    expect(record).toMatchObject({ decision: "annotated", noop: false, target: file });
  }, 30_000);
});

// The Claude Code mod (plannotator tool `gate: true`, `/plannotator-annotate
// x --gate`, a taken-over `plannotator annotate x --gate` run) launches plain
// `--gate` with the result file, and the classic skill runs plain `--gate`.
// Failure caught: the header hiding "Approve with a note…" there (the advert
// used to require --json), or a note approved there being dropped.
describe("gated approval with a note, plaintext launch", () => {
  const page = (root: string) => writeFileSync(join(root, "page.html"), "<!doctype html><h1>Plan</h1><p>Body.</p>");
  const NOTE = "Approved, but rename the header before shipping.";

  test("an HTML file advertises approval notes; the note reaches stdout and the host record", async () => {
    const run = start(["page.html", "--gate"], page);
    const base = await run.base();
    const plan = await (await fetch(`${base}/api/plan`)).json() as { renderAs?: string; gate?: boolean; approvalNotesSupported?: boolean };
    expect(plan).toMatchObject({ renderAs: "html", gate: true, approvalNotesSupported: true });

    await post(base, "/api/approve", { feedback: NOTE, annotations: [], codeAnnotations: [] });
    const { code, stdout, record } = await run.finish();
    expect(code).toBe(0);
    expect(stdout).toContain(NOTE);
    expect(stdout).toContain(join(run.root, "page.html"));
    expect(record).toMatchObject({ surface: "annotate", decision: "approved", noop: false });
    expect(record.message).toContain(NOTE);
  }, 30_000);

  test("a bare approval keeps the legacy stdout marker and stays a no-op", async () => {
    const run = start(["page.html", "--gate"], page);
    await post(await run.base(), "/api/approve", { feedback: "", annotations: [], codeAnnotations: [] });
    const { stdout, record } = await run.finish();
    expect(stdout.trim()).toBe("The user approved.");
    expect(record).toMatchObject({ decision: "approved", noop: true });
  }, 30_000);

  test("--hook (no message on approval) keeps the advert off", async () => {
    const run = start(["page.html", "--gate", "--hook"], page);
    const base = await run.base();
    const plan = await (await fetch(`${base}/api/plan`)).json() as { approvalNotesSupported?: boolean };
    expect(plan.approvalNotesSupported).toBe(false);
    await post(base, "/api/approve", { annotations: [], codeAnnotations: [] });
    await run.finish();
  }, 30_000);
});
