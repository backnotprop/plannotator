import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteDraft, getDraftGeneration, loadDraft, saveDraft } from "./draft";

const KEY = "draft-generation-test";

let dataDir = "";
let previousDataDir: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-draft-generation-"));
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("draft generation invalidation", () => {
  test("ignores stale saves that arrive after a newer delete", () => {
    deleteDraft(KEY, 2);

    expect(saveDraft(KEY, { annotations: ["stale"], draftGeneration: 1 })).toBe(false);
    expect(loadDraft(KEY)).toBeNull();

    expect(saveDraft(KEY, { annotations: ["fresh"], draftGeneration: 3 })).toBe(true);
    expect(loadDraft(KEY)).toEqual({ annotations: ["fresh"], draftGeneration: 3 });
  });

  test("keeps rejecting older delayed saves after a newer generated draft is accepted", () => {
    deleteDraft(KEY, 2);

    expect(saveDraft(KEY, { annotations: ["fresh"], draftGeneration: 3 })).toBe(true);
    expect(saveDraft(KEY, { annotations: ["late stale"], draftGeneration: 1 })).toBe(false);
    expect(loadDraft(KEY)).toEqual({ annotations: ["fresh"], draftGeneration: 3 });
  });

  test("rejects older generated saves after a newer generated draft exists", () => {
    expect(saveDraft(KEY, { annotations: ["fresh"], draftGeneration: 3 })).toBe(true);

    expect(saveDraft(KEY, { annotations: ["older"], draftGeneration: 2 })).toBe(false);
    expect(loadDraft(KEY)).toEqual({ annotations: ["fresh"], draftGeneration: 3 });
  });

  test("reports the newest known generation from a draft or tombstone", () => {
    expect(getDraftGeneration(KEY)).toBeNull();

    deleteDraft(KEY, 2);
    expect(getDraftGeneration(KEY)).toBe(2);

    expect(saveDraft(KEY, { annotations: ["fresh"], draftGeneration: 3 })).toBe(true);
    expect(getDraftGeneration(KEY)).toBe(3);
  });

  test("keeps legacy saves without a generation compatible", () => {
    deleteDraft(KEY, 2);

    expect(saveDraft(KEY, { annotations: ["legacy"] })).toBe(true);
    expect(loadDraft(KEY)).toEqual({ annotations: ["legacy"] });
  });

  test("plain legacy delete clears tombstone state", () => {
    deleteDraft(KEY, 2);
    deleteDraft(KEY);

    expect(getDraftGeneration(KEY)).toBeNull();
    expect(saveDraft(KEY, { annotations: ["fresh"], draftGeneration: 0 })).toBe(true);
    expect(loadDraft(KEY)).toEqual({ annotations: ["fresh"], draftGeneration: 0 });
  });

  test("ignores stale generated deletes after a newer draft exists", () => {
    expect(saveDraft(KEY, { annotations: ["fresh"], draftGeneration: 3 })).toBe(true);

    deleteDraft(KEY, 2);

    expect(getDraftGeneration(KEY)).toBe(3);
    expect(loadDraft(KEY)).toEqual({ annotations: ["fresh"], draftGeneration: 3 });
  });

  test("ignores stale generated deletes after a newer tombstone exists", () => {
    deleteDraft(KEY, 4);

    deleteDraft(KEY, 3);

    expect(getDraftGeneration(KEY)).toBe(4);
    expect(saveDraft(KEY, { annotations: ["stale"], draftGeneration: 4 })).toBe(false);
    expect(saveDraft(KEY, { annotations: ["fresh"], draftGeneration: 5 })).toBe(true);
  });

  test("same-generation generated delete still removes the draft", () => {
    expect(saveDraft(KEY, { annotations: ["fresh"], draftGeneration: 3 })).toBe(true);

    deleteDraft(KEY, 3);

    expect(getDraftGeneration(KEY)).toBe(3);
    expect(loadDraft(KEY)).toBeNull();
  });

  test("newer generated delete removes the draft and advances the tombstone", () => {
    expect(saveDraft(KEY, { annotations: ["fresh"], draftGeneration: 3 })).toBe(true);

    deleteDraft(KEY, 4);

    expect(getDraftGeneration(KEY)).toBe(4);
    expect(loadDraft(KEY)).toBeNull();
    expect(saveDraft(KEY, { annotations: ["stale"], draftGeneration: 4 })).toBe(false);
    expect(saveDraft(KEY, { annotations: ["new"], draftGeneration: 5 })).toBe(true);
  });
});
