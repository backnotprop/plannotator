/**
 * PR review drafts reachable by target identity (#1590).
 *
 * Every test sandboxes drafts under its own temp PLANNOTATOR_DATA_DIR (set
 * inside the test, restored in afterEach) — never the real ~/.plannotator.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, getDraftDir, loadDraft, saveDraft } from "./draft";
import { deleteReviewDraft, loadReviewDraft, prDraftTargetKey, saveReviewDraft } from "./review-draft";
import type { PRMetadata } from "./pr-types";

const github: PRMetadata = {
  platform: "github",
  host: "github.com",
  owner: "Acme",
  repo: "Widgets",
  number: 42,
  title: "t",
  author: "a",
  baseBranch: "main",
  headBranch: "feature",
  baseSha: "b",
  headSha: "h",
  url: "https://github.com/Acme/Widgets/pull/42",
};

const P1 = contentHash("patch one");
const P2 = contentHash("patch two");

let savedDataDir: string | undefined;
let dataDir: string;

beforeEach(() => {
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-review-draft-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function draft(generation: number, text = "note") {
  return { codeAnnotations: [{ id: `a${generation}`, text }], draftGeneration: generation, ts: 1 };
}

describe("prDraftTargetKey", () => {
  test("is stable across metadata that is not identity, case-insensitive on repo, and distinct per scope and PR", () => {
    const layer = prDraftTargetKey(github, "layer");
    expect(prDraftTargetKey({ ...github, headSha: "new", title: "renamed" }, "layer")).toBe(layer);
    expect(prDraftTargetKey({ ...github, owner: "acme", repo: "widgets" }, "layer")).toBe(layer);
    expect(prDraftTargetKey(github, "full-stack")).not.toBe(layer);
    expect(prDraftTargetKey({ ...github, number: 43 }, "layer")).not.toBe(layer);
    expect(prDraftTargetKey({ ...github, host: "ghe.example.com" }, "layer")).not.toBe(layer);
    // Never collides with a content-hash key's shape.
    expect(layer).toMatch(/^pr-[0-9a-f]{16}$/);
  });
});

describe("without a target key (every non-PR review)", () => {
  test("writes exactly the one patch-key file with the body verbatim", () => {
    const body = draft(1);
    expect(saveReviewDraft({ patchKey: P1 }, body)).toBe(true);
    expect(readdirSync(getDraftDir())).toEqual([`${P1}.json`]);
    expect(loadDraft(P1)).toEqual(body);
    expect(loadReviewDraft({ patchKey: P1 })).toEqual({ found: true, draft: body });
    expect(loadReviewDraft({ patchKey: P2 })).toEqual({ found: false, draftGeneration: null });
  });
});

describe("with a target key (PR mode)", () => {
  const T = prDraftTargetKey(github, "layer");

  test("an unchanged patch restores through the patch key exactly as before", () => {
    saveReviewDraft({ patchKey: P1, targetKey: T }, draft(3));
    const loaded = loadReviewDraft({ patchKey: P1, targetKey: T });
    expect(loaded).toEqual({ found: true, draft: draft(3) });
  });

  test("a new patch finds the draft through the target key and is told the patch changed", () => {
    saveReviewDraft({ patchKey: P1, targetKey: T }, draft(3));
    const loaded = loadReviewDraft({ patchKey: P2, targetKey: T });
    expect(loaded.found).toBe(true);
    if (!loaded.found) return;
    expect(loaded.draft.codeAnnotations).toEqual(draft(3).codeAnnotations);
    expect(loaded.draft.patchChanged).toBe(true);
    // The server's stamp is internal; it never reaches the client.
    expect("patchKey" in loaded.draft).toBe(false);
  });

  test("a newer target copy beats a stale patch-key copy from an earlier visit to the same patch", () => {
    // Session 1 on P1, session 2 on P2 continues the draft, the PR is then
    // force-pushed back to P1: the P1 file is older than what session 2 saved.
    saveReviewDraft({ patchKey: P1, targetKey: T }, draft(3, "old"));
    saveReviewDraft({ patchKey: P2, targetKey: T }, draft(5, "newer"));
    const loaded = loadReviewDraft({ patchKey: P1, targetKey: T });
    expect(loaded.found && (loaded.draft.codeAnnotations as Array<{ text: string }>)[0].text).toBe("newer");
    expect(loaded.found && loaded.draft.patchChanged).toBe(true);
  });

  test("a client cannot forge the server's patchChanged / patchKey fields", () => {
    saveReviewDraft({ patchKey: P1, targetKey: T }, { ...draft(2), patchChanged: true, patchKey: P2 });
    const loaded = loadReviewDraft({ patchKey: P1, targetKey: T });
    expect(loaded.found && loaded.draft.patchChanged).toBeUndefined();
  });

  test("delete clears the patch key, the target key, and the patch the target copy was last saved on", () => {
    saveReviewDraft({ patchKey: P1, targetKey: T }, draft(3));
    // A new session on P2 loaded it but has not saved yet, then submits.
    deleteReviewDraft({ patchKey: P2, targetKey: T }, 4);
    expect(loadReviewDraft({ patchKey: P2, targetKey: T }).found).toBe(false);
    expect(loadReviewDraft({ patchKey: P1, targetKey: T }).found).toBe(false);
    expect(existsSync(join(getDraftDir(), `${P1}.json`))).toBe(false);
    expect(existsSync(join(getDraftDir(), `${T}.json`))).toBe(false);
  });

  test("after a delete, a late save from another tab (older generation) is rejected under BOTH keys", () => {
    saveReviewDraft({ patchKey: P2, targetKey: T }, draft(3));
    deleteReviewDraft({ patchKey: P2, targetKey: T }, 4);
    // Stale tab still looking at the older patch P1, debounced save gen 4.
    expect(saveReviewDraft({ patchKey: P1, targetKey: T }, draft(4))).toBe(false);
    expect(existsSync(join(getDraftDir(), `${P1}.json`))).toBe(false);
    // Stale tab on the current patch, gen 2.
    expect(saveReviewDraft({ patchKey: P2, targetKey: T }, draft(2))).toBe(false);
    expect(loadReviewDraft({ patchKey: P1, targetKey: T }).found).toBe(false);
    expect(loadReviewDraft({ patchKey: P2, targetKey: T }).found).toBe(false);
  });

  test("the 404 carries the tombstone generation so the next client resumes past it", () => {
    saveReviewDraft({ patchKey: P1, targetKey: T }, draft(3));
    deleteReviewDraft({ patchKey: P1, targetKey: T }, 7);
    expect(loadReviewDraft({ patchKey: P2, targetKey: T })).toEqual({ found: false, draftGeneration: 7 });
    // A save past the tombstone is a new draft and is accepted.
    expect(saveReviewDraft({ patchKey: P2, targetKey: T }, draft(8))).toBe(true);
    expect(loadReviewDraft({ patchKey: P2, targetKey: T }).found).toBe(true);
  });

  test("a patch-key draft written before the target key was deleted is not resurrected", () => {
    // An orphaned patch-key copy (e.g. from a tab the delete could not name)
    // at or below the target tombstone is dead.
    saveDraft(P1, draft(2));
    saveReviewDraft({ patchKey: P2, targetKey: T }, draft(3));
    deleteReviewDraft({ patchKey: P2, targetKey: T }, 4);
    expect(loadReviewDraft({ patchKey: P1, targetKey: T }).found).toBe(false);
  });

  test("a pre-existing patch-key-only draft (written before this change) still restores on its unchanged patch", () => {
    saveDraft(P1, draft(2));
    expect(loadReviewDraft({ patchKey: P1, targetKey: T })).toEqual({ found: true, draft: draft(2) });
  });
});
