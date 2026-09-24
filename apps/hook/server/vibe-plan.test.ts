/**
 * Vibe Plan Resolver Tests
 *
 * Run: bun test apps/hook/server/vibe-plan.test.ts
 *
 * Uses synthetic fixtures in temp dirs matching Vibe's $VIBE_HOME/plans and
 * logs/session layouts. VIBE_HOME is saved in beforeEach and restored in
 * afterEach (house testing rule: never leak a mutated env past a test).
 */

import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  resolveLatestVibePlan,
  resolveVibePlansDir,
  findVibePlanInTranscript,
  findNewestVibePlan,
  PLAN_FRESHNESS_MS,
} from "./vibe-plan";

const tempDirs: string[] = [];
let savedVibeHome: string | undefined;

function cleanup() {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

beforeEach(() => {
  savedVibeHome = process.env.VIBE_HOME;
});

afterEach(() => {
  if (savedVibeHome === undefined) delete process.env.VIBE_HOME;
  else process.env.VIBE_HOME = savedVibeHome;
  cleanup();
});

function makeVibeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "vibe-home-"));
  tempDirs.push(home);
  mkdirSync(join(home, "plans"), { recursive: true });
  return home;
}

/** A Vibe transcript line: tool results carry tool_result.output shaped by
 * the tool's project_result (write_file: file_path/bytes_written/content;
 * edit: file/old_string/new_string). */
function toolResultLine(output: Record<string, unknown>): string {
  return JSON.stringify({ role: "tool", tool_call_id: "tc1", tool_result: { output, duration: 0.5 } });
}

describe("resolveVibePlansDir", () => {
  test("defaults to ~/.vibe/plans when VIBE_HOME unset", () => {
    delete process.env.VIBE_HOME;
    const dir = resolveVibePlansDir();
    expect(dir).toBe(join(homedir(), ".vibe", "plans"));
  });

  test("respects VIBE_HOME override", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vibe-override-"));
    tempDirs.push(tmp);
    process.env.VIBE_HOME = tmp;
    expect(resolveVibePlansDir()).toBe(join(tmp, "plans"));
  });

  test("accepts explicit vibeHome argument over env", () => {
    process.env.VIBE_HOME = mkdtempSync(join(tmpdir(), "ignored-"));
    tempDirs.push(process.env.VIBE_HOME!);
    const arg = mkdtempSync(join(tmpdir(), "arg-wins-"));
    tempDirs.push(arg);
    expect(resolveVibePlansDir(arg)).toBe(join(arg, "plans"));
  });
});

describe("findVibePlanInTranscript", () => {
  test("pins the last write_file result targeting the plans dir", () => {
    const home = makeVibeHome();
    const planPath = join(home, "plans", "1789000000-my-plan.md");
    writeFileSync(planPath, "# Pinned plan");
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      [
        toolResultLine({ file_path: "/elsewhere/notes.md", bytes_written: 3, content: "x" }),
        JSON.stringify({ role: "assistant", content: "writing the plan" }),
        toolResultLine({ file_path: planPath, bytes_written: 10, content: "# Pinned plan" }),
        "",
      ].join("\n"),
    );
    expect(findVibePlanInTranscript(transcript, { vibeHome: home })).toBe(planPath);
  });

  test("pins edit results via the `file` key too", () => {
    const home = makeVibeHome();
    const planPath = join(home, "plans", "1789000001-edited.md");
    writeFileSync(planPath, "# Edited");
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, [
      toolResultLine({ file: planPath, message: "ok", old_string: "a", new_string: "b" }),
    ].join("\n"));
    expect(findVibePlanInTranscript(transcript, { vibeHome: home })).toBe(planPath);
  });

  test("returns null when the transcript has no plans-dir write", () => {
    const home = makeVibeHome();
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, [
      toolResultLine({ file_path: "/elsewhere/notes.md", bytes_written: 3, content: "x" }),
    ].join("\n"));
    expect(findVibePlanInTranscript(transcript, { vibeHome: home })).toBeNull();
  });

  test("ignores a plans-dir path that no longer exists (failed/rolled-back write)", () => {
    const home = makeVibeHome();
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, [
      toolResultLine({ file_path: join(home, "plans", "gone.md"), bytes_written: 1, content: "x" }),
    ].join("\n"));
    expect(findVibePlanInTranscript(transcript, { vibeHome: home })).toBeNull();
  });

  test("pins through a symlinked VIBE_HOME (transcript names the real path)", () => {
    const home = makeVibeHome();
    const planPath = join(home, "plans", "1789000002-linked.md");
    writeFileSync(planPath, "# Linked");
    const linkParent = mkdtempSync(join(tmpdir(), "vibe-link-"));
    tempDirs.push(linkParent);
    const linkedHome = join(linkParent, "vibe");
    symlinkSync(home, linkedHome, "dir");
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, toolResultLine({ file_path: planPath, bytes_written: 1, content: "x" }));
    expect(findVibePlanInTranscript(transcript, { vibeHome: linkedHome })).toBe(planPath);
    // And the reverse: VIBE_HOME is real, the transcript spells the link.
    const linkedPlan = join(linkedHome, "plans", "1789000002-linked.md");
    writeFileSync(transcript, toolResultLine({ file_path: linkedPlan, bytes_written: 1, content: "x" }));
    expect(findVibePlanInTranscript(transcript, { vibeHome: home })).toBe(linkedPlan);
  });

  test("tolerates a non-normalized transcript path but not a plans subdirectory", () => {
    const home = makeVibeHome();
    writeFileSync(join(home, "plans", "1789000003-slash.md"), "# Slash");
    // A doubled separator / `.` segment used to leave dirname() with a
    // trailing slash (or a `.`) that the exact string compare missed.
    const unnormalized = `${home}/./plans//1789000003-slash.md`;
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, toolResultLine({ file_path: unnormalized, bytes_written: 1, content: "x" }));
    expect(findVibePlanInTranscript(transcript, { vibeHome: `${home}/` })).toBe(unnormalized);

    mkdirSync(join(home, "plans", "nested"));
    const nested = join(home, "plans", "nested", "deep.md");
    writeFileSync(nested, "# Nested");
    writeFileSync(transcript, toolResultLine({ file_path: nested, bytes_written: 1, content: "x" }));
    expect(findVibePlanInTranscript(transcript, { vibeHome: home })).toBeNull();
  });

  test("returns null for a missing transcript", () => {
    const home = makeVibeHome();
    expect(findVibePlanInTranscript(join(home, "nope.jsonl"), { vibeHome: home })).toBeNull();
  });
});

describe("findNewestVibePlan", () => {
  test("returns the newest .md plan by mtime inside the freshness window", () => {
    const home = makeVibeHome();
    const old = join(home, "plans", "1780000000-old-plan.md");
    const newer = join(home, "plans", "1780001000-new-plan.md");
    writeFileSync(old, "# Old plan");
    writeFileSync(newer, "# New plan");
    const now = Date.now();
    const sec = (ms: number) => Math.floor(ms / 1000);
    utimesSync(old, sec(now - PLAN_FRESHNESS_MS - 5000), sec(now - PLAN_FRESHNESS_MS - 5000));
    utimesSync(newer, sec(now - 1000), sec(now - 1000));
    const found = findNewestVibePlan({ vibeHome: home, now });
    expect(found?.content).toBe("# New plan");
    expect(found?.path).toBe(newer);
  });

  test("returns null when the only plan is older than the freshness window", () => {
    const home = makeVibeHome();
    const stale = join(home, "plans", "1780000000-stale.md");
    writeFileSync(stale, "# Stale plan");
    const now = Date.now();
    const staleSec = Math.floor((now - PLAN_FRESHNESS_MS - 60000) / 1000);
    utimesSync(stale, staleSec, staleSec);
    expect(findNewestVibePlan({ vibeHome: home, now })).toBeNull();
  });

  test("returns null when plans dir is empty or missing", () => {
    const home = makeVibeHome();
    expect(findNewestVibePlan({ vibeHome: home })).toBeNull();
    const noDir = mkdtempSync(join(tmpdir(), "vibe-noplans-"));
    tempDirs.push(noDir);
    expect(findNewestVibePlan({ vibeHome: noDir })).toBeNull();
  });
});

describe("resolveLatestVibePlan", () => {
  test("prefers the transcript-pinned plan over a newer mtime plan", () => {
    const home = makeVibeHome();
    const pinned = join(home, "plans", "1789000000-pinned.md");
    const newest = join(home, "plans", "1789009999-newest.md");
    writeFileSync(pinned, "# Pinned plan");
    writeFileSync(newest, "# Newest plan");
    // newest has the later mtime; the transcript points at pinned.
    utimesSync(pinned, 1, 1);
    utimesSync(newest, 100, 100);
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, [
      toolResultLine({ file_path: pinned, bytes_written: 13, content: "# Pinned plan" }),
    ].join("\n"));
    expect(resolveLatestVibePlan({ vibeHome: home, transcriptPath: transcript, now: 1000 })).toBe("# Pinned plan");
  });

  test("falls back to newest-by-mtime when the transcript names no plan", () => {
    const home = makeVibeHome();
    const newer = join(home, "plans", "1780001000-new-plan.md");
    writeFileSync(newer, "# New plan");
    const now = Date.now();
    utimesSync(newer, now - 1000, now - 1000);
    const transcript = join(home, "t.jsonl");
    writeFileSync(transcript, [
      toolResultLine({ file_path: "/elsewhere/x.md", bytes_written: 1, content: "x" }),
    ].join("\n"));
    expect(resolveLatestVibePlan({ vibeHome: home, transcriptPath: transcript, now })).toBe("# New plan");
  });

  test("fails open (null) with no transcript and no fresh plan", () => {
    const home = makeVibeHome();
    const stale = join(home, "plans", "1780000000-stale.md");
    writeFileSync(stale, "# Stale");
    const now = Date.now();
    const staleSec = Math.floor((now - PLAN_FRESHNESS_MS - 60000) / 1000);
    utimesSync(stale, staleSec, staleSec);
    expect(resolveLatestVibePlan({ vibeHome: home, now })).toBeNull();
  });

  test("ignores non-.md files", () => {
    const home = makeVibeHome();
    writeFileSync(join(home, "plans", "note.txt"), "not a plan");
    expect(resolveLatestVibePlan({ vibeHome: home })).toBeNull();
  });
});
