/**
 * A draft keeps a folder pick that is no project yet (approval "launch-create-clone", D8): `start` is checked when it
 * is saved, so a draft can never carry a path outside `~/`, another kind of machine id, or a made-up flag that a
 * reopened compose would act on; and it comes back as it was saved.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInboxDraft, saveInboxDraft } from "./drafts";

const dir = mkdtempSync(join(tmpdir(), "plannotator-drafts-start-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ID = "drf_01ARZ3NDEKTSV4RRFFQ69G5FT2";
const AT = "2026-11-07T10:00:00.000Z";

test("a Create pick is kept and read back as saved", () => {
  const start = { agent: "claude-code", machine: "ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW", folder: "~/code/pricing-page", name: "pricing-page", create: true };
  saveInboxDraft(dir, ID, { body: "Add a pricing page.", start }, AT);
  expect(readInboxDraft(dir, ID)?.start).toEqual(start);
  // No pick: no field.
  saveInboxDraft(dir, ID, { body: "x", base: readInboxDraft(dir, ID)!.updated_at }, AT);
  expect(readInboxDraft(dir, ID)).not.toHaveProperty("start");
});

test("a pick that isn't one is refused: a path outside ~/, a machine that isn't an Inbox id, an odd create", () => {
  const ok = { agent: "claude-code", machine: null, folder: "~/code/x", name: "x" };
  for (const start of [{ ...ok, folder: "/etc" }, { ...ok, machine: "mini" }, { ...ok, create: "yes" }, { ...ok, name: "" }, "~/code/x"]) {
    expect(() => saveInboxDraft(dir, "drf_01ARZ3NDEKTSV4RRFFQ69G5FT3", { body: "x", start }, AT)).toThrow("start:");
  }
});
