/**
 * The plan library's records, pure. What regresses if these fail:
 * - a version's id stops matching `git hash-object` (an export or a later sync would see every version as changed);
 * - an id of the wrong kind, a bad version number or a foreign line passes as a record;
 * - the one write a window makes (a look) takes a field it should refuse;
 * - an imported approval whose version was never found drops out of view ("No decision") instead of staying history
 *   on the first version;
 * - a page's file name loses its own name or kind.
 */
import { describe, expect, test } from "bun:test";
import {
  planPictureSize,
  planPictureTypeOf,
  checkPlanLookInput,
  gitBlobSha,
  isPlanDecision,
  isPlanEvent,
  isPlanId,
  isPlanRecord,
  isPlanVersion,
  NO_ACTOR,
  planApprovalState,
  planDocumentFileName,
  planHeadingOf,
  planId,
  type PlanEvent,
  sha1Hex,
} from "./plans";

describe("gitBlobSha", () => {
  test("is git's blob id: the empty file, a word, and a multi-block, non-ASCII text", () => {
    // `git hash-object --stdin` of each.
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(gitBlobSha(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    // SHA-1 itself across the 55/56/64-byte padding edges (FIPS 180 vectors and known digests).
    expect(sha1Hex(new TextEncoder().encode("abc"))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe("84983e441c3bd26ebaae4aa1f95129e5e54670f1");
    expect(sha1Hex(new TextEncoder().encode("a".repeat(1000)))).toBe("291e9a6c66994949b57ba5e650361e98fc36b1ba");
    expect(gitBlobSha("# Plan ✓\n")).not.toBe(gitBlobSha("# Plan v\n"));
  });
});

describe("ids", () => {
  test("each prefix makes ids only its own check takes", () => {
    const id = planId("pln");
    expect(isPlanId("pln", id)).toBe(true);
    expect(isPlanId("doc", id)).toBe(false);
    expect(isPlanId("doc", planId("doc"))).toBe(true);
    expect(isPlanId("actev", planId("actev"))).toBe(true);
    expect(isPlanId("pln", "pln_short")).toBe(false);
    expect(isPlanId("pln", `pln_${"I".repeat(26)}`)).toBe(false); // not Crockford
    expect(isPlanId("pln", null)).toBe(false);
  });
});

const at = "2026-11-10T09:00:00.000Z";
const plan = () => ({
  id: planId("pln"),
  name: "Auth refactor",
  note: null,
  project_id: null,
  project_root: null,
  project_name: "api",
  primary_doc_id: planId("doc"),
  status: "active",
  thread_id: null,
  created_at: at,
  updated_at: at,
  created_by: NO_ACTOR,
  legacy: null,
});

describe("record checks", () => {
  test("a plan record passes; a wrong status, a bad id or a bad date does not", () => {
    expect(isPlanRecord(plan())).toBe(true);
    expect(isPlanRecord({ ...plan(), status: "open" })).toBe(false);
    expect(isPlanRecord({ ...plan(), primary_doc_id: "doc_1" })).toBe(false);
    expect(isPlanRecord({ ...plan(), created_at: "yesterday" })).toBe(false);
    expect(isPlanRecord([plan()])).toBe(false);
  });

  test("a version must name a docs/<doc>/<n> file, a whole number and a blob sha", () => {
    const doc = planId("doc");
    const version = { version: gitBlobSha("x"), version_number: 2, document_id: doc, plan_id: planId("pln"), file: `docs/${doc}/2.md`, size: 1, committed_at: at, source: "plan-review", legacy: null, ...NO_ACTOR };
    expect(isPlanVersion(version)).toBe(true);
    expect(isPlanVersion({ ...version, version_number: 0 })).toBe(false);
    expect(isPlanVersion({ ...version, version_number: 1.5 })).toBe(false);
    expect(isPlanVersion({ ...version, file: "../../etc/passwd" })).toBe(false);
    expect(isPlanVersion({ ...version, version: "abc" })).toBe(false);
    expect(isPlanVersion({ ...version, source: "magic" })).toBe(false);
  });

  test("a decision event carries a decision; another kind need not", () => {
    const doc = planId("doc");
    const decision = { document_id: doc, version: null, version_number: null, decision: "approved", at, feedback: null, feedback_record: null, snapshot: null };
    expect(isPlanDecision(decision)).toBe(true);
    expect(isPlanDecision({ ...decision, decision: "lgtm" })).toBe(false);
    const event = { id: planId("actev"), plan_id: planId("pln"), kind: "decision", at, subject: null, decision, legacy: null, ...NO_ACTOR };
    expect(isPlanEvent(event)).toBe(true);
    expect(isPlanEvent({ ...event, decision: undefined })).toBe(false);
    expect(isPlanEvent({ ...event, kind: "version_saved", decision: undefined })).toBe(true);
  });
});

describe("checkPlanLookInput", () => {
  test("takes doc and seen, or nothing; refuses anything else", () => {
    const doc = planId("doc");
    expect(checkPlanLookInput({})).toEqual({ ok: true, doc: null, seen: null });
    expect(checkPlanLookInput(undefined)).toEqual({ ok: true, doc: null, seen: null });
    expect(checkPlanLookInput({ doc, seen: 3, serverSession: "s" })).toEqual({ ok: true, doc, seen: 3 });
    expect(checkPlanLookInput({ seen: 0 }).ok).toBe(false);
    expect(checkPlanLookInput({ doc: "doc_x" }).ok).toBe(false);
    expect(checkPlanLookInput({ plan: "x" }).ok).toBe(false);
    expect(checkPlanLookInput("seen").ok).toBe(false);
  });
});

describe("planHeadingOf", () => {
  test("the first level-one heading, else null", () => {
    expect(planHeadingOf("intro\n# Auth refactor \n## Steps")).toBe("Auth refactor");
    expect(planHeadingOf("## Only a subheading")).toBeNull();
    expect(planHeadingOf("")).toBeNull();
  });
});

describe("an approval whose version was never found", () => {
  test("stays history on the first version: approved while v1 is the newest, then cleared, never lost", () => {
    const event = { ...NO_ACTOR, id: "actev_1", plan_id: "pln_1", kind: "decision", at: "2026-11-02T09:00:00.000Z", subject: null, legacy: "feedback/p/index.jsonl#1", decision: { document_id: "doc_1", version: null, version_number: null, decision: "approved", at: "2026-11-02T09:00:00.000Z", feedback: null, feedback_record: null, snapshot: null } } as PlanEvent;
    expect(planApprovalState([event], "doc_1", 1)).toMatchObject({ kind: "approved", version_number: 1 });
    expect(planApprovalState([event], "doc_1", 3)).toEqual({ kind: "cleared", version_number: 3, from_version_number: 1, names: ["person"] });
  });
});

describe("planDocumentFileName", () => {
  test("the document's own file name, else its title with its kind's extension", () => {
    expect(planDocumentFileName({ doc_path: "plans/rollout.md", title: "Rollout", kind: "markdown" })).toBe("rollout.md");
    expect(planDocumentFileName({ doc_path: null, title: "Request flow", kind: "mermaid" })).toBe("Request flow.mmd");
    expect(planDocumentFileName({ doc_path: null, title: "", kind: "html" })).toBe("Plan.html");
  });
});

test("a picture page's type comes from its bytes, never its name", () => {
  const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
  expect(planPictureTypeOf(bytes("\x89PNG\r\n\x1a\n"))).toBe("image/png");
  expect(planPictureTypeOf(bytes("\xff\xd8\xff\xe0"))).toBe("image/jpeg");
  expect(planPictureTypeOf(bytes("GIF89a\x01\x00"))).toBe("image/gif");
  expect(planPictureTypeOf(bytes("RIFF\x00\x00\x00\x00WEBPVP8 "))).toBe("image/webp");
  expect(planPictureTypeOf(bytes("\x00\x00\x00\x1cftypavif"))).toBe("image/avif");
  expect(planPictureTypeOf(new TextEncoder().encode('\uFEFF<?xml version="1.0"?>\n<!-- chart -->\n<svg xmlns="http://www.w3.org/2000/svg">'))).toBe("image/svg+xml");
  // An HTML page that holds an SVG is no picture; nor is text.
  expect(planPictureTypeOf(new TextEncoder().encode("<html><svg></svg></html>"))).toBeNull();
  expect(planPictureTypeOf(new TextEncoder().encode("tier,rate"))).toBeNull();
});

test("a picture's size comes from its header, never a decode; a header that does not say is null", () => {
  const bytes = (...parts: (number | string)[]) => Uint8Array.from(parts.flatMap((p) => (typeof p === "number" ? [p] : [...p].map((c) => c.charCodeAt(0)))));
  const png = bytes(0x89, "PNG\r\n\x1a\n", 0, 0, 0, 13, "IHDR", 0, 0, 0x27, 0x10, 0, 0, 0x4e, 0x20);
  expect(planPictureSize(png)).toEqual({ width: 10000, height: 20000 });
  expect(planPictureSize(bytes("GIF89a", 0x40, 0x01, 0xf0, 0x00))).toEqual({ width: 320, height: 240 });
  // A JPEG: an APP0 segment first, then the frame header (height 600, width 800).
  const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x02, 0x58, 0x03, 0x20, 3, 0, 0, 0);
  expect(planPictureSize(jpeg)).toEqual({ width: 800, height: 600 });
  const webp = bytes("RIFF", 0, 0, 0, 0, "WEBPVP8X", 10, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x4e, 0, 0x1f, 0x4e, 0);
  expect(planPictureSize(webp)).toEqual({ width: 20000, height: 20000 });
  expect(planPictureSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="99999">'))).toBeNull();
  expect(planPictureSize(bytes(0xff, 0xd8, 0xff))).toBeNull();
});
