/**
 * The plan of a share (pure). What regresses if these fail:
 * - a path a hosted space refuses (`#`, `%`, `.git`, `..`) is taken here, or two pages get one path;
 * - a page or file over the hosted limit, a comment over 8 KiB, a comment the agent already has or a reply whose
 *   comment is not in the space is planned to go up;
 * - a space nobody kept is planned an approval, or a kept one is not;
 * - the button reads the wrong word for where the share stands.
 */
import { describe, expect, test } from "bun:test";
import { isPlanAssetPath, type PlanComment } from "./plans";
import { isSpacePath, newSpaceId, newSpaceShareRecord, planSpaceShare, SPACE_FILE_MAX, SPACE_OPEN_FILES_MAX, SPACE_TEXT_MAX, spaceShareButton, spacePagePath, isSpaceId, type LocalSpace, type SpaceShareStatus } from "./space-share";

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
  test("a local file path refuses what a hosted space refuses", () => {
    for (const path of ["a#b.png", "50%.png", ".git/config", "x/.git/y", "../x", "a\\b", "a?b"]) expect(isPlanAssetPath(path)).toBe(false);
    expect(isPlanAssetPath("notes/chart 2.png")).toBe(true);
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
    expect(plan.details).toEqual({ pages: 1, files: 1, comments: 2, approval: null, not: { sent_comments: 1, pictures: 1, original_dates: true, files_over: 1, pages_over: 1, long_comments: 1, older_approvals: 1 } });
    expect(plan.changes).toBe(4);
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

  test("the approval: planned last and only for a kept space; shown in Details either way; never again once refused", () => {
    const approved = local({ approval: { document_id: DOC, version_number: 2 } });
    const open = planSpaceShare(approved, null, { mode: "all", signedIn: false });
    expect(open.steps.some((s) => s.kind === "approval")).toBe(false);
    expect(open.details.approval).toBe(2);
    const kept = planSpaceShare(approved, null, { mode: "all", signedIn: true });
    expect(kept.steps[kept.steps.length - 1]).toEqual({ kind: "approval", doc: DOC, version: 2 });
    const refused = { ...record(), kept: true, approval_refused: true };
    const after = planSpaceShare(approved, refused, { mode: "all", signedIn: true });
    expect(after.steps.some((s) => s.kind === "approval")).toBe(false);
    expect(after.details.approval).toBeNull();
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

describe("the button", () => {
  const status = (more: Partial<SpaceShareStatus>): SpaceShareStatus => ({ phase: "none", progress: null, waiting: null, link: null, shared_once: false, kept: false, signed_in: false, who: null, keep: null, mode: "all", versions: 1, changes: 0, stopped_pages: [], details: {} as SpaceShareStatus["details"], ...more });
  test("reads Share, Sharing, Shared or Update, with a mark when it needs a look", () => {
    expect(spaceShareButton(null)).toEqual({ label: "Share", state: "idle" });
    expect(spaceShareButton(status({ phase: "sharing" }))).toEqual({ label: "Sharing", state: "busy" });
    expect(spaceShareButton(status({ phase: "shared", shared_once: true }))).toEqual({ label: "Shared", state: "shared" });
    expect(spaceShareButton(status({ phase: "shared", shared_once: true, changes: 2 }))).toEqual({ label: "Update", state: "update" });
    expect(spaceShareButton(status({ phase: "shared", shared_once: true, changes: 2, stopped_pages: [{ title: "Rollout" }] }))).toEqual({ label: "Shared", state: "look" });
    expect(spaceShareButton(status({ phase: "refused", shared_once: true }))).toEqual({ label: "Shared", state: "look" });
    expect(spaceShareButton(status({ phase: "failed" }))).toEqual({ label: "Share", state: "failed" });
    expect(spaceShareButton(status({ phase: "failed", shared_once: true }))).toEqual({ label: "Shared", state: "look" });
  });
});
