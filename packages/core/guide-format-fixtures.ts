import type { GuideSnapshot, GuideSnapshotV1, GuideSnapshotV2 } from "./guide-format";

export const FIXTURE_PATCH_TS_JSON = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,4 +1,6 @@
 export function refresh(token: string) {
-  return token;
+  if (!token) throw new Error("missing token");
+  const html = '</script><!--';
+  return token + "!";
 }
diff --git a/package.json b/package.json
index 3333333..4444444 100644
--- a/package.json
+++ b/package.json
@@ -1,3 +1,4 @@
 {
-  "name": "demo"
+  "name": "demo",
+  "version": "1.0.1"
 }
`;

/** v1, local since-base guide — the canonical minimal document. */
export const FIXTURE_V1_LOCAL: GuideSnapshotV1 = {
  kind: "plannotator-guided-review",
  version: 1,
  exportedAt: "2026-08-15T20:00:00.000Z",
  guide: {
    title: "Auth token refresh",
    intent: "Harden the refresh path and bump the package version.",
    sections: [
      {
        title: "Guard the refresh entry point",
        overview: "The refresh function now rejects a missing token instead of echoing it back.",
        diffs: [{ file: "src/auth.ts", summary: "Adds the guard and a trailing marker." }],
      },
      { title: "Housekeeping", overview: "Version bump only.", diffs: [{ file: "package.json", summary: "1.0.1" }] },
    ],
    unplacedFiles: [],
    reviewed: [true, false],
  },
  review: { rawPatch: FIXTURE_PATCH_TS_JSON, gitRef: "origin/main..HEAD", diffType: "since-base", base: "origin/main" },
  source: { kind: "local", repo: "acme/demo", branch: "feat/refresh", headSha: "0123456789abcdef0123456789abcdef01234567" },
  generator: { engine: "claude", model: "sonnet", generatedAt: "2026-08-15T19:58:00.000Z" },
};

/** v1, PR guide with generator provenance including custom instructions and a theme hint. */
export const FIXTURE_V1_PR: GuideSnapshotV1 = {
  ...FIXTURE_V1_LOCAL,
  guide: { ...FIXTURE_V1_LOCAL.guide, title: "PR: auth token refresh" },
  source: {
    kind: "pr",
    repo: "acme/demo",
    branch: "feat/refresh",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    pr: { url: "https://github.com/acme/demo/pull/42", number: 42, title: "Auth token refresh", platform: "github" },
  },
  generator: { engine: "codex", model: "gpt-5.5", customInstructions: "Focus on security implications." },
  theme: { palette: "plannotator" },
};

/** v1, single-commit guide. */
export const FIXTURE_V1_COMMIT: GuideSnapshotV1 = {
  ...FIXTURE_V1_LOCAL,
  review: { rawPatch: FIXTURE_PATCH_TS_JSON, gitRef: "Commit 0123456 — Auth token refresh", diffType: "commit:0123456789abcdef0123456789abcdef01234567" },
  source: { kind: "commit", repo: "acme/demo", commitSha: "0123456789abcdef0123456789abcdef01234567" },
};

/** v1, multi-repo workspace guide (folder-prefixed paths). */
export const FIXTURE_V1_WORKSPACE: GuideSnapshotV1 = {
  ...FIXTURE_V1_LOCAL,
  guide: {
    ...FIXTURE_V1_LOCAL.guide,
    sections: [
      { title: "API", overview: "Server side.", diffs: [{ file: "api/src/auth.ts" }] },
      { title: "Web", overview: "Client side.", diffs: [{ file: "web/package.json" }] },
    ],
    reviewed: [false, false],
  },
  review: {
    rawPatch: FIXTURE_PATCH_TS_JSON.replaceAll("/src/auth.ts", "/api/src/auth.ts").replaceAll("/package.json", "/web/package.json"),
    gitRef: "api | web",
    diffType: "workspace-current",
  },
  source: { kind: "workspace", repo: "monorepo-parent" },
  generator: undefined,
};

/** v2, local guide with an overview: prose with guide links and a Mermaid diagram with `click` links. */
export const FIXTURE_V2_OVERVIEW: GuideSnapshotV2 = {
  ...FIXTURE_V1_LOCAL,
  version: 2,
  guide: {
    title: FIXTURE_V1_LOCAL.guide.title,
    intent: FIXTURE_V1_LOCAL.guide.intent,
    overview: {
      text: "The guard in [`refresh`](symbol:src/auth.ts#refresh) runs first ([code](code:src/auth.ts#L2-L3)); the version bump is [chapter 2](chapter:2).",
      diagram: {
        kind: "mermaid",
        source: 'flowchart LR\n  caller --> refresh\n  refresh --> guard\n  click refresh "symbol:refresh"\n  click guard "code:src/auth.ts#L2"',
      },
    },
    sections: FIXTURE_V1_LOCAL.guide.sections,
    unplacedFiles: FIXTURE_V1_LOCAL.guide.unplacedFiles,
    reviewed: FIXTURE_V1_LOCAL.guide.reviewed,
  },
};

/** v2, PR guide whose overview is prose only (no diagram). */
export const FIXTURE_V2_PR_TEXT: GuideSnapshotV2 = {
  ...FIXTURE_V1_PR,
  version: 2,
  guide: {
    title: FIXTURE_V1_PR.guide.title,
    intent: FIXTURE_V1_PR.guide.intent,
    overview: { text: "One guard and a version bump. Read [chapter 1](chapter:1) first." },
    sections: FIXTURE_V1_PR.guide.sections,
    unplacedFiles: FIXTURE_V1_PR.guide.unplacedFiles,
    reviewed: FIXTURE_V1_PR.guide.reviewed,
  },
};

/** v2, overview with a sanitized HTML picture (accepted by the format; no viewer draws it yet). */
export const FIXTURE_V2_HTML: GuideSnapshotV2 = {
  ...FIXTURE_V1_LOCAL,
  version: 2,
  guide: {
    title: FIXTURE_V1_LOCAL.guide.title,
    intent: FIXTURE_V1_LOCAL.guide.intent,
    overview: {
      text: "A custom picture of the refresh path.",
      diagram: { kind: "html", source: '<svg viewBox="0 0 10 10"><a href="code:src/auth.ts"><rect width="10" height="10"/></a></svg>' },
    },
    sections: FIXTURE_V1_LOCAL.guide.sections,
    unplacedFiles: FIXTURE_V1_LOCAL.guide.unplacedFiles,
    reviewed: FIXTURE_V1_LOCAL.guide.reviewed,
  },
};

export const GUIDE_SNAPSHOT_FIXTURES: ReadonlyArray<{ readonly name: string; readonly snapshot: GuideSnapshot }> = [
  { name: "v1-local", snapshot: FIXTURE_V1_LOCAL },
  { name: "v1-pr", snapshot: FIXTURE_V1_PR },
  { name: "v1-commit", snapshot: FIXTURE_V1_COMMIT },
  { name: "v1-workspace", snapshot: FIXTURE_V1_WORKSPACE },
  { name: "v2-overview", snapshot: FIXTURE_V2_OVERVIEW },
  { name: "v2-pr-text", snapshot: FIXTURE_V2_PR_TEXT },
  { name: "v2-html", snapshot: FIXTURE_V2_HTML },
];
