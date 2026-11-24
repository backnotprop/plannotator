/**
 * The plan of a share (pure). What regresses if these fail:
 * - a path a hosted space refuses (`#`, `%`, `.git`, `..`) is taken here, or two pages get one path;
 * - a page or file over the hosted limit, a comment over 8 KiB, a comment the agent already has or a reply whose
 *   comment is not in the space is planned to go up;
 * - an approval call is ever planned (a tool's is always refused), or Details lists an approval that is not up;
 * - the button reads the wrong word for where the share stands.
 */
import { describe, expect, test } from "bun:test";
import { isPlanAssetPath, planId, type PlanComment } from "./plans";
import { isSpaceShareRecord, spaceCommentAnchor, spaceExternalKey, spaceImportedFields, spaceFilePath, isSpacePath, newSpaceId, newSpaceShareRecord, planSpaceShare, spaceKeepApproval, SPACE_FILE_MAX, SPACE_OPEN_FILES_MAX, SPACE_TEXT_MAX, spaceShareButton, spacePagePath, isSpaceId, type LocalSpace, type SpaceShareStatus } from "./space-share";

const DOC = "doc_01HZZZZZZZZZZZZZZZZZZZZZZ1";
const DOC2 = "doc_01HZZZZZZZZZZZZZZZZZZZZZZ2";
const hash = (n: number) => String(n).repeat(40).slice(0, 40);
const comment = (id: string, annotation: Record<string, unknown>, more: Partial<PlanComment> = {}): PlanComment => ({
  id: `anno_01HZZZZZZZZZZZZZZZZZZZZZ${id}`,
  plan_id: "pln_01HZZZZZZZZZZZZZZZZZZZZZZ0",
  target: { kind: "document", document_id: DOC, document_version: hash(2) },
  anchor: { id, ...annotation },
  body: String(annotation.text ?? ""),
  state: "open",
  created_at: `2026-11-11T10:00:0${id.length}.000Z`,
  sent: null,
  author_label: null,
  author_via: "person",
  agent_host: null,
  agent_session: null,
  agent_name: null,
  ...more,
});
const local = (more: Partial<LocalSpace> = {}): LocalSpace => ({
  name: "Plan",
  primary_doc_id: DOC,
  documents: [{ id: DOC, kind: "markdown", title: "Plan", doc_path: null, file_extension: null, versions: [{ version_number: 1, version: hash(1), size: 10 }, { version_number: 2, version: hash(2), size: 12 }] }],
  artifacts: [],
  comments: [],
  approval: null,
  older_approvals: 0,
  ...more,
});
const record = () => newSpaceShareRecord({ host: "http://127.0.0.1:1", space_id: newSpaceId(), name: "Plan", mode: "all", kept: false, at: "2026-11-11T10:00:00.000Z" });

describe("paths", () => {
  test("a file's name here is not changed by sharing: what a hosted space refuses is written another way on the way up", () => {
    // The library takes these names as before (the switch off changes nothing).
    for (const path of ["a#b.png", "50%.png"]) expect(isPlanAssetPath(path)).toBe(true);
    expect(spaceFilePath("notes/chart.png", new Set())).toBe("notes/chart.png");
    expect(spaceFilePath("a#b 50%.png", new Set())).toBe("a-b 50-.png");
    expect(isSpacePath(spaceFilePath("a#b 50%.png", new Set()))).toBe(true);
    expect(spaceFilePath("a#b.png", new Set(["a-b.png"]))).toBe("a-b 2.png");
    expect(spaceFilePath("chart.png", new Set(["chart.png"]))).toBe("chart 2.png");
  });

  test("a hosted path", () => {
    for (const path of ["a#b", "a%b", "a?b", "a\\b", "/a", "a/", "a//b", ".", "a/../b", ".GIT/x", "a\nb", `${"é".repeat(128)}.md`]) expect(isSpacePath(path)).toBe(false);
    for (const path of ["plan.md", "notes/a b.md", ".hidden"]) expect(isSpacePath(path)).toBe(true);
  });

  test("a page's path: its own when the space takes it for that kind, else its title; never one taken", () => {
    expect(spacePagePath({ doc_path: "docs/rollout.md", title: "Rollout" }, "md", "markdown", new Set())).toBe("docs/rollout.md");
    expect(spacePagePath({ doc_path: "docs/flow.md", title: "Flow" }, "mmd", "mermaid", new Set())).toBe("Flow.mmd");
    expect(spacePagePath({ doc_path: null, title: "50% off: Q#3 / plan?" }, "md", "markdown", new Set())).toBe("50 off Q 3 plan.md");
    expect(spacePagePath({ doc_path: null, title: "Plan" }, "md", "markdown", new Set(["plan.md"]))).toBe("Plan 2.md");
    expect(spacePagePath({ doc_path: null, title: "..." }, "md", "markdown", new Set())).toBe("plan.md");
    expect(isSpaceId(newSpaceId())).toBe(true);
  });
});

describe("the steps", () => {
  test("all versions: the create with v1, then a save; newest: the create with the newest", () => {
    expect(planSpaceShare(local(), null, { mode: "all", signedIn: false }).steps).toEqual([
      { kind: "create", doc: DOC, version: 1 },
      { kind: "page-save", doc: DOC, version: 2 },
    ]);
    expect(planSpaceShare(local(), null, { mode: "newest", signedIn: false }).steps).toEqual([{ kind: "create", doc: DOC, version: 2 }]);
  });

  test("what stays: over a limit, already with the agent, too long, a reply to a comment that stays", () => {
    const plan = planSpaceShare(
      local({
        documents: [
          { id: DOC, kind: "markdown", title: "Plan", doc_path: null, file_extension: null, versions: [{ version_number: 1, version: hash(1), size: 10 }, { version_number: 2, version: hash(2), size: 12 }] },
          { id: DOC2, kind: "markdown", title: "Huge", doc_path: null, file_extension: null, versions: [{ version_number: 1, version: hash(3), size: SPACE_TEXT_MAX + 1 }] },
        ],
        artifacts: [
          { asset_path: "movie.mov", content_hash: "a".repeat(64), content_type: "video/quicktime", size: SPACE_FILE_MAX + 1, title: null, created_at: "2026-11-11T10:00:00.000Z" },
          { asset_path: "ok.png", content_hash: "b".repeat(64), content_type: "image/png", size: 5, title: null, created_at: "2026-11-11T10:00:00.000Z" },
        ],
        comments: [
          comment("A", { text: "open", images: [{ path: "/x.png", name: "x" }] }),
          comment("B", { text: "sent" }, { sent: { at: "2026-11-11T10:00:00.000Z", message_id: "m", to: { host: "", session: "" } } }),
          comment("C", { text: "x".repeat(9000) }),
          comment("D", { text: "reply to sent", inReplyTo: "B" }),
          comment("E", { text: "reply to open", inReplyTo: "A" }),
          comment("F", { text: "on a version not up" }, { target: { kind: "document", document_id: DOC, document_version: hash(9) } }),
        ],
        older_approvals: 1,
      }),
      null,
      { mode: "all", signedIn: false },
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(["create", "page-save", "file", "comment", "reply"]);
    // The anchor says where and what, never who or when.
    expect(spaceCommentAnchor(comment("Z", { text: "x", originalText: "q", author: "swift-otter", mentions: ["@maya"], createdA: 1, images: [{ path: "/p.png", name: "p" }] }))).toEqual({ id: "Z", text: "x", originalText: "q" });
    // An allow-list: a tool, page, PR and artifact addresses, an element's description and anything unknown stay; the
    // id and an answer to a question go, as the space's parsers read them.
    const leaky = spaceCommentAnchor(comment("L", { type: "COMMENT", text: "x", originalText: "q", source: "eslint", pageUrl: "/p", prUrl: "https://github.com/a/b/pull/1", artifact: { artifactUrl: "https://x/a", sourceUrl: "https://x/s" }, elementContext: { tag: "div" }, futureField: "?", imageRegion: { v: 1, src: "https://example.com/i.png", sourceLine: null, box: { x: 0, y: 0, w: 1, h: 1 }, naturalWidth: 2, naturalHeight: 2 } }));
    expect(leaky).toEqual({ id: "L", type: "COMMENT", text: "x", originalText: "q", imageRegion: { v: 1, src: "https://example.com/i.png", sourceLine: null, box: { x: 0, y: 0, w: 1, h: 1 }, naturalWidth: 2, naturalHeight: 2 } });
    // A picture's reference: relative inside the plan or on the web goes (the parser needs one); one naming this computer stays.
    const srcOf = (src: string) => (spaceCommentAnchor(comment("I", { imageRegion: { v: 1, src, sourceLine: 1, box: { x: 0, y: 0, w: 1, h: 1 }, naturalWidth: 2, naturalHeight: 2 } })).imageRegion as Record<string, unknown>).src;
    for (const src of ["figures/x.png", "./shot.png", "a/../b.png", "https://example.com/i.png"]) expect(srcOf(src)).toBe(src);
    for (const src of ["/Users/me/shot.png", "~/shot.png", "file:///tmp/a.png", "C:\\a.png", "C:/a.png", "\\\\server\\share\\a.png", "../outside.png", "a/../../outside.png", "data:image/png;base64,AA"]) expect(srcOf(src)).toBeUndefined();
    expect(plan.details).toEqual({ pages: 1, files: 1, comments: 2, approval: null, not: { sent_comments: 1, pictures: 1, original_dates: true, files_over: 1, pages_over: 1, long_comments: 1, older_approvals: 1 } });
    expect(plan.changes).toBe(4);
  });

  test("a file the space does not take under its name goes up under another, kept in the plan", () => {
    const plan = planSpaceShare(local({ artifacts: [{ asset_path: "q#3 50%.png", content_hash: "e".repeat(64), content_type: "image/png", size: 5, title: null, created_at: "2026-11-11T10:00:00.000Z" }] }), null, { mode: "newest", signedIn: false });
    expect(plan.steps.map((s) => s.kind)).toEqual(["create", "file"]);
    expect(plan.file_paths).toEqual({ "q#3 50%.png": "q-3 50-.png" });
    expect(plan.details.files).toBe(1);
  });

  test("a file with a page's extension goes up as a page; a picture page as a file, counted against the open limit", () => {
    const plan = planSpaceShare(
      local({
        documents: [...local().documents, { id: DOC2, kind: "image", title: "Chart", doc_path: null, file_extension: "png", versions: [{ version_number: 1, version: hash(4), size: SPACE_OPEN_FILES_MAX }] }],
        artifacts: [{ asset_path: "mock.html", content_hash: "c".repeat(64), content_type: "text/html", size: 50, title: null, created_at: "2026-11-11T10:00:00.000Z" }, { asset_path: "a.bin", content_hash: "d".repeat(64), content_type: "application/octet-stream", size: 1, title: null, created_at: "2026-11-11T10:00:00.000Z" }],
      }),
      null,
      { mode: "newest", signedIn: false },
    );
    expect(plan.steps.map((s) => s.kind)).toEqual(["create", "page-file", "file-page", "file"]);
    expect(plan.paths[DOC2]).toBe("Chart.png");
    expect(plan.file_bytes).toBe(SPACE_OPEN_FILES_MAX + 1);
  });

  test("the approval: never a step; listed in Details only while it is up (recorded, the page not saved or changed since)", () => {
    const approved = local({ approval: { document_id: DOC, version_number: 2 } });
    const kinds = (plan: ReturnType<typeof planSpaceShare>) => plan.steps.map((s) => s.kind as string);
    // Not up: a share signed in to the person's own space plans no approval and lists none.
    const fresh = planSpaceShare(approved, null, { mode: "all", signedIn: true });
    expect(kinds(fresh)).not.toContain("approval");
    expect(fresh.details.approval).toBeNull();
    const upKept = () => {
      const r = { ...record(), created: true, kept: true };
      r.pages[DOC] = { lane: "page", remote_id: "doc_remote", doc_path: "Plan.md", pushed: [{ local: 1, remote: "r1", hash: hash(1) }, { local: 2, remote: "r2", hash: hash(2) }], stopped: null };
      return r;
    };
    const notRecorded = planSpaceShare(approved, upKept(), { mode: "all", signedIn: true });
    expect(notRecorded.steps).toEqual([]);
    expect(notRecorded.details.approval).toBeNull();
    // Recorded with Keep: listed, and still nothing to send.
    const recorded = { ...upKept(), approval: { document_id: DOC, version_number: 2 } };
    const listed = planSpaceShare(approved, recorded, { mode: "all", signedIn: true });
    expect(listed.details.approval).toBe(2);
    expect(listed.steps).toEqual([]);
    // A newer version approved here is not the one recorded there; a page changed there is not either.
    const newer = local({ approval: { document_id: DOC, version_number: 3 } });
    newer.documents[0]!.versions.push({ version_number: 3, version: hash(3), size: 14 });
    expect(planSpaceShare(newer, recorded, { mode: "all", signedIn: true }).details.approval).toBeNull();
    const changedThere = { ...upKept(), approval: { document_id: DOC, version_number: 2 } };
    changedThere.pages[DOC]!.stopped = { current: "r9" };
    expect(planSpaceShare(approved, changedThere, { mode: "all", signedIn: true }).details.approval).toBeNull();
    // A space nobody kept lists none; an old record that says the tool's approval was refused locks nothing out.
    expect(planSpaceShare(approved, { ...recorded, kept: false }, { mode: "all", signedIn: true }).details.approval).toBeNull();
    expect(planSpaceShare(approved, { ...recorded, approval_refused: true }, { mode: "all", signedIn: true }).details.approval).toBe(2);
  });

  test("an Update plans only what is new, and leaves a stopped page alone", () => {
    const r = record();
    r.created = true;
    r.pages[DOC] = { lane: "page", remote_id: "doc_x", doc_path: "Plan.md", pushed: [{ local: 1, remote: hash(1), hash: hash(1) }, { local: 2, remote: hash(2), hash: hash(2) }], stopped: null };
    expect(planSpaceShare(local(), r, { mode: "all", signedIn: false })).toMatchObject({ steps: [], changes: 0 });
    const grown = local();
    grown.documents[0]!.versions.push({ version_number: 3, version: hash(3), size: 9 });
    expect(planSpaceShare(grown, r, { mode: "all", signedIn: false }).steps).toEqual([{ kind: "page-save", doc: DOC, version: 3 }]);
    r.pages[DOC]!.stopped = { current: hash(7) };
    expect(planSpaceShare(grown, r, { mode: "all", signedIn: false }).steps).toEqual([]);
  });
});

describe("the approval Keep sends", () => {
  test("only the person's approval of the version the space holds, of a space that is up and not someone else's", () => {
    const approved = local({ approval: { document_id: DOC, version_number: 2 } });
    const up = () => {
      const r = record();
      r.created = true;
      r.pages[DOC] = { lane: "page", remote_id: "doc_remote", doc_path: "Plan.md", pushed: [{ local: 1, remote: "r1", hash: "h1" }, { local: 2, remote: "r2", hash: "h2" }], stopped: null };
      return r;
    };
    expect(spaceKeepApproval(approved, up())).toEqual({ document_id: DOC, version_number: 2, remote_document: "doc_remote", remote_version: "r2" });
    expect(spaceKeepApproval(local(), up())).toBeNull();
    expect(spaceKeepApproval(approved, null)).toBeNull();
    // The approved version is not the one the space holds (not up yet, or the page changed there).
    const behind = up();
    behind.pages[DOC]!.pushed.pop();
    expect(spaceKeepApproval(approved, behind)).toBeNull();
    const stopped = up();
    stopped.pages[DOC]!.stopped = { current: "r9" };
    expect(spaceKeepApproval(approved, stopped)).toBeNull();
    const refused = up();
    refused.refused = true;
    expect(spaceKeepApproval(approved, refused)).toBeNull();
    const unmade = up();
    unmade.created = false;
    expect(spaceKeepApproval(approved, unmade)).toBeNull();
  });
});

describe("the button", () => {
  const status = (more: Partial<SpaceShareStatus>): SpaceShareStatus => ({ phase: "none", progress: null, waiting: null, link: null, shared_once: false, kept: false, access: "edit", signed_in: false, who: null, keep: null, mode: "all", versions: 1, changes: 0, stopped_pages: [], details: {} as SpaceShareStatus["details"], ...more });
  test("reads Share, Sharing, Shared or Update, with a mark when it needs a look", () => {
    expect(spaceShareButton(null)).toEqual({ label: "Share", state: "idle" });
    expect(spaceShareButton(status({ phase: "sharing" }))).toEqual({ label: "Sharing", state: "busy" });
    expect(spaceShareButton(status({ phase: "shared", shared_once: true }))).toEqual({ label: "Shared", state: "shared" });
    expect(spaceShareButton(status({ phase: "shared", shared_once: true, changes: 2 }))).toEqual({ label: "Update", state: "update" });
    expect(spaceShareButton(status({ phase: "shared", shared_once: true, changes: 2, stopped_pages: [{ title: "Rollout" }] }))).toEqual({ label: "Shared", state: "look" });
    expect(spaceShareButton(status({ phase: "refused", shared_once: true }))).toEqual({ label: "Shared", state: "look" });
    expect(spaceShareButton(status({ phase: "shared", shared_once: true, changes: 2, needs_keep: true }))).toEqual({ label: "Shared", state: "look" });
    expect(spaceShareButton(status({ phase: "gone", shared_once: true }))).toEqual({ label: "Shared", state: "look" });
    expect(spaceShareButton(status({ phase: "failed" }))).toEqual({ label: "Share", state: "failed" });
    expect(spaceShareButton(status({ phase: "failed", shared_once: true }))).toEqual({ label: "Shared", state: "look" });
  });
});

describe("what a call says of where a thing came from", () => {
  test("only the share's time goes: never the author, the agent or the thing's own time", () => {
    const origin = { author_label: "Maya Chen", agent_host: "claude-code", agent_session: "s-1", agent_name: "Claude", at: "2026-11-02T09:15:00.000Z" };
    expect(spaceImportedFields(origin, "2026-11-20T10:00:00.000Z")).toEqual({ actor: { kind: "imported", at: "2026-11-20T10:00:00.000Z" } });
  });

  test("the plan's id is the key only signed in, and only when the service takes it as one", () => {
    const id = planId("pln");
    expect(spaceExternalKey(id, true)).toBe(id);
    expect(spaceExternalKey(id, false)).toBeNull();
    // Share as new: a key of its own, from the new space's id, never one an older space had.
    const space = newSpaceId();
    expect(spaceExternalKey(id, true, space)).toBe(`${id}:${space.slice(3)}`);
    expect(spaceExternalKey(id, false, space)).toBeNull();
    expect(spaceExternalKey("x".repeat(110), true, space)).toBeNull();
    for (const bad of ["", "pln 1", "x".repeat(129), "pln/1", null]) expect(spaceExternalKey(bad, true)).toBeNull();
  });
});

test("a record read back with a share time or Share as new mark of the wrong kind is no record", () => {
  const record = newSpaceShareRecord({ host: "https://spaces.invalid", space_id: newSpaceId(), name: "P", mode: "all", kept: false, as_new: true, at: "2026-11-20T10:00:00.000Z" });
  expect(isSpaceShareRecord(record)).toBe(true);
  expect(isSpaceShareRecord({ ...record, seed: { doc: null, version: null, at: "2026-11-20T10:00:00.000Z" } })).toBe(true);
  expect(isSpaceShareRecord({ ...record, seed: { doc: null, version: null, at: 5 } })).toBe(false);
  expect(isSpaceShareRecord({ ...record, as_new: "yes" })).toBe(false);
});
