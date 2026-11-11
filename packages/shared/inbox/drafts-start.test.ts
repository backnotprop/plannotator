import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInboxDraft, saveInboxDraft } from "./drafts";

const dir = mkdtempSync(join(tmpdir(), "plannotator-drafts-start-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ID = "drf_01ARZ3NDEKTSV4RRFFQ69G5FT2";
const AT = "2026-11-07T10:00:00.000Z";

test("a pick on another drive is kept by its full path (approval inbox-launch-any-folder)", () => {
  const start = { agent: "claude-code", machine: null, folder: "/Volumes/Studio SSD/footage", name: "footage" };
  saveInboxDraft(dir, "drf_01ARZ3NDEKTSV4RRFFQ69G5FT6", { body: "Grade the second pass.", start }, AT);
  expect(readInboxDraft(dir, "drf_01ARZ3NDEKTSV4RRFFQ69G5FT6")?.start).toEqual(start);
});

test("a Create pick is kept and read back as saved", () => {
  const start = { agent: "claude-code", machine: "ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW", folder: "~/code/pricing-page", name: "pricing-page", create: true };
  saveInboxDraft(dir, ID, { body: "Add a pricing page.", start }, AT);
  expect(readInboxDraft(dir, ID)?.start).toEqual(start);
  saveInboxDraft(dir, ID, { body: "x", base: readInboxDraft(dir, ID)!.updated_at }, AT);
  expect(readInboxDraft(dir, ID)).not.toHaveProperty("start");
});

test("a pick that isn't one is refused: a path that isn't a full one or steps out, a machine that isn't an Inbox id, an odd create", () => {
  const ok = { agent: "claude-code", machine: null, folder: "~/code/x", name: "x" };
  for (const start of [{ ...ok, folder: "code/x" }, { ...ok, folder: "~/../etc" }, { ...ok, folder: "/Volumes/../etc" }, { ...ok, machine: "mini" }, { ...ok, create: "yes" }, { ...ok, name: "" }, "~/code/x"]) {
    expect(() => saveInboxDraft(dir, "drf_01ARZ3NDEKTSV4RRFFQ69G5FT3", { body: "x", start }, AT)).toThrow("start:");
  }
});

test("a clone pick keeps its URL and branch; a URL git can't take, or a branch that reads as an option, is refused", () => {
  const start = { agent: "claude-code", machine: null, folder: "~/code/billing-api", name: "billing-api", clone: { url: "git@github.com:acme/billing-api.git", branch: "release-2.1" } };
  saveInboxDraft(dir, "drf_01ARZ3NDEKTSV4RRFFQ69G5FT4", { body: "Find the cent drift.", start }, AT);
  expect(readInboxDraft(dir, "drf_01ARZ3NDEKTSV4RRFFQ69G5FT4")?.start).toEqual(start);
  for (const clone of [{ url: "--upload-pack=x" }, { url: "file:///etc" }, { url: "https://github.com/acme/x", branch: "--upload-pack=x" }, "https://github.com/acme/x"]) {
    expect(() => saveInboxDraft(dir, "drf_01ARZ3NDEKTSV4RRFFQ69G5FT5", { body: "x", start: { ...start, clone } }, AT)).toThrow("start:");
  }
});
