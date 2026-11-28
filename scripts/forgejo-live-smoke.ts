/**
 * Live smoke test for Forgejo / Gitea PR review. NOT run in CI.
 * Run through scripts/forgejo-live-smoke.sh, which maps and checks the env.
 *
 * Two modes:
 *
 * READ-ONLY (FORGEJO_SMOKE_READONLY_PR=<PR URL>). Writes nothing and needs no
 * token for a public repository. Runs this checkout's `plannotator review
 * <PR URL>` headlessly against an existing PR and checks the diff, metadata,
 * context (comments, reviews, inline threads) and file content it serves.
 *
 * FULL (only with FORGEJO_SMOKE_WRITE=1; without it nothing is written).
 * Against a real instance it:
 *   1. creates a throwaway PRIVATE repo (plannotator-smoke-<stamp>) in the
 *      token's account (the only repo this script ever deletes),
 *   2. commits a base and two feature commits through the contents API (no git
 *      push credentials) and opens a PR,
 *   3. seeds an issue comment, a two-comment inline thread and an uploaded
 *      image referenced the way Forgejo's editor writes it (/attachments/<uuid>),
 *   4. runs `plannotator review <PR URL>` headlessly and checks the diff, the
 *      metadata, the seeded comments and thread, file content, the image
 *      preview and the attachment (a private repo: this proves the token),
 *   5. posts a comment review with a general comment and three inline comments
 *      (new side, old side, multi-line) and verifies each anchor through the
 *      Forgejo API,
 *   6. approves and requests changes on your OWN PR and checks that Forgejo's
 *      refusal reaches the caller. Forgejo refuses both; that is what the
 *      Forgejo capabilities (selfReviewBlocked, selfRequestChangesBlocked)
 *      claim, checked here against a real instance,
 *   7. with a second account (PLANNOTATOR_FORGEJO_REVIEWER_TOKEN): approves,
 *      then requests changes, as that reviewer and checks the PR's decision,
 *   8. optionally (FORGEJO_SMOKE_LOCAL=1) waits for the --local checkout,
 *   9. deletes the repo (unless FORGEJO_SMOKE_KEEP=1).
 *
 * EXISTING REPO (FORGEJO_SMOKE_REPO=<owner>/<name>) uses a repository you made
 * instead of creating one, so the token needs no scope for creating
 * repositories. The script writes commits to its default branch, so it refuses
 * anything but an initialized repository whose name starts with
 * "plannotator-smoke", and a private one unless FORGEJO_SMOKE_ALLOW_PUBLIC=1
 * (a public scratch repository on a server you control). It never deletes the
 * repository: it closes its PR and
 * deletes its feature branch, and its files stay in a smoke-<stamp>/ folder on
 * the default branch. Delete the repository yourself when done.
 *
 * Tokens are read from the environment and never printed: every line this
 * script writes goes through redact().
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "apps/hook/server/index.ts");
const READONLY_PR = process.env.FORGEJO_SMOKE_READONLY_PR ?? "";
const TOKEN = process.env.PLANNOTATOR_FORGEJO_TOKEN ?? "";
const REVIEWER_TOKEN = process.env.PLANNOTATOR_FORGEJO_REVIEWER_TOKEN ?? "";
const KEEP = process.env.FORGEJO_SMOKE_KEEP === "1";
/** Creating, writing and deleting on the instance happens only when asked for by name. */
const WRITE = process.env.FORGEJO_SMOKE_WRITE === "1";
const WITH_LOCAL = process.env.FORGEJO_SMOKE_LOCAL === "1";
const STAMP = Date.now().toString(36);
/** An existing repository to use, as owner/name; empty means create a throwaway one. */
const EXISTING = process.env.FORGEJO_SMOKE_REPO ?? "";
const ALLOW_PUBLIC = process.env.FORGEJO_SMOKE_ALLOW_PUBLIC === "1";
const REPO = EXISTING ? (EXISTING.split("/")[1] ?? "") : `plannotator-smoke-${STAMP}`;
/** Every file lives under a per-run folder and branch, so a repository can be reused. */
const DIR = `smoke-${STAMP}`;
const MATH_PATH = `${DIR}/src/math.ts`;
const GREET_PATH = `${DIR}/src/greet.ts`;
const NOTES_PATH = `${DIR}/notes.txt`;
const PNG_PATH = `${DIR}/dot.png`;
const BRANCH = `feature/smoke-${STAMP}`;

/** `scheme://host[:port]` of the instance: the URL given, or the PR URL in read-only mode. */
const ORIGIN = (() => {
  try {
    return new URL(READONLY_PR || process.env.PLANNOTATOR_FORGEJO_URL || "").origin;
  } catch {
    return "";
  }
})();
const API = `${ORIGIN}/api/v1`;
/** The origin PLANNOTATOR_FORGEJO_URL names: the one instance a configured token belongs to. */
const TOKEN_ORIGIN = (() => {
  try {
    return new URL(process.env.PLANNOTATOR_FORGEJO_URL || "").origin;
  } catch {
    return "";
  }
})();

const SECRETS = [TOKEN, REVIEWER_TOKEN].filter((s) => s !== "");
function redact(s: string): string {
  let out = s;
  for (const secret of SECRETS) out = out.split(secret).join("[REDACTED]");
  return out;
}
const log = (...parts: unknown[]) => console.log(redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined && !ok ? `  ${JSON.stringify(detail)}` : ""}`);
}

/** One call to the instance's API as the holder of `token`. */
async function fj(method: string, path: string, body?: unknown, token = TOKEN): Promise<any> {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `token ${token}` } : {}),
      ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
    },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(redact(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`));
  return text ? JSON.parse(text) : null;
}

interface Session { proc: ReturnType<typeof Bun.spawn>; url: string; dir: string; stderr: () => string }

/** `plannotator review <PR URL>` headlessly, with `token` (or none) as the Forgejo token. */
async function startReview(prUrl: string, token: string, local: boolean): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-fj-smoke-"));
  const ready = join(dir, "ready.json");
  let stderr = "";
  const env: Record<string, string | undefined> = {
    ...process.env,
    PLANNOTATOR_CWD: dir,
    PLANNOTATOR_DATA_DIR: join(dir, "data"),
    PLANNOTATOR_READY_FILE: ready,
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_FORGEJO_TOKEN: token || undefined,
    PLANNOTATOR_FORGEJO_URL: token ? ORIGIN : undefined,
    // Git over HTTPS with the token (the --local clone): the helper reads it from the environment at call
    // time, so it never appears in argv, a URL, or git config on disk.
    GIT_TERMINAL_PROMPT: "0",
    ...(token
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `credential.${ORIGIN}.helper`,
          GIT_CONFIG_VALUE_0: `!f() { echo username=oauth2; echo "password=$PLANNOTATOR_FORGEJO_TOKEN"; }; f`,
        }
      : {}),
  };
  const proc = Bun.spawn([process.execPath, CLI, "review", prUrl, ...(local ? [] : ["--no-local"])], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  (async () => { for await (const c of proc.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(c); })();
  for (let i = 0; i < 300 && !existsSync(ready); i++) await Bun.sleep(100);
  if (!existsSync(ready)) throw new Error(`review server did not start:\n${redact(stderr)}`);
  const url = (JSON.parse(readFileSync(ready, "utf-8")) as { url: string }).url.replace(/\/$/, "");
  return { proc, url, dir, stderr: () => stderr };
}
async function stopReview(s: Session) {
  await fetch(`${s.url}/api/exit`, { method: "POST" }).catch(() => {});
  await Promise.race([s.proc.exited, Bun.sleep(5000)]);
  s.proc.kill();
  rmSync(s.dir, { recursive: true, force: true });
}
async function getJson(s: Session, path: string): Promise<any> {
  return (await fetch(`${s.url}${path}`)).json();
}
async function prAction(s: Session, body: unknown) {
  const res = await fetch(`${s.url}/api/pr-action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

// --- read-only mode -------------------------------------------------------------------------------

async function readOnly(prUrl: string) {
  // A token is for one instance: it is used only when this PR is on the origin PLANNOTATOR_FORGEJO_URL names.
  const token = TOKEN && TOKEN_ORIGIN === ORIGIN ? TOKEN : "";
  log(`==> Read-only review of ${prUrl} (nothing is written; ${token ? "with the configured token" : "anonymous"})`);
  const s = await startReview(prUrl, token, false);
  try {
    const diff = await getJson(s, "/api/diff");
    const meta = diff.prMetadata ?? {};
    check("served as a Forgejo PR", meta.platform === "forgejo", meta);
    check("metadata has the PR's shas and branches", /^[0-9a-f]{40}$/.test(meta.headSha ?? "") && /^[0-9a-f]{40}$/.test(meta.baseSha ?? "") && !!meta.headBranch && !!meta.baseBranch, meta);
    check("merge base resolved", /^[0-9a-f]{40}$/.test(meta.mergeBaseSha ?? ""), meta.mergeBaseSha);
    check("url is the one the review was opened on", meta.url === prUrl.replace(/[?#].*$/, "").replace(/\/(files|commits).*$/, ""), meta.url);
    const files = (diff.rawPatch?.match(/^diff --git a\/(.+?) b\//gm) ?? []) as string[];
    check("a patch was served", files.length > 0, diff.rawPatch?.slice(0, 200));
    log(`    ${meta.owner}/${meta.repo}#${meta.number} by ${meta.author}: ${files.length} file(s), head ${String(meta.headSha).slice(0, 12)}`);

    const ctx = await getJson(s, "/api/pr-context");
    check("context has the expected shape", ["OPEN", "CLOSED", "MERGED"].includes(ctx.state) && Array.isArray(ctx.comments) && Array.isArray(ctx.reviews) && Array.isArray(ctx.reviewThreads) && Array.isArray(ctx.checks), Object.keys(ctx));
    log(`    state ${ctx.state}, ${ctx.comments.length} comment(s), ${ctx.reviews.length} review(s), ${ctx.reviewThreads.length} inline thread(s), decision "${ctx.reviewDecision}"`);
    for (const t of ctx.reviewThreads as any[]) {
      check(`thread ${t.path}:${t.line} is anchored`, !!t.path && t.line > 0 && (t.diffSide === "LEFT" || t.diffSide === "RIGHT") && t.comments.length > 0, t);
    }

    const first = files[0]?.match(/^diff --git a\/(.+?) b\//)?.[1];
    if (first) {
      const fc = await getJson(s, `/api/file-content?path=${encodeURIComponent(first)}`);
      check(`file content at the merge base and head (${first})`, fc.oldContent !== undefined && fc.newContent !== undefined && (fc.oldContent !== null || fc.newContent !== null), Object.keys(fc));
    }
  } finally {
    await stopReview(s);
  }
}

// --- full mode ----------------------------------------------------------------------------------------

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n";

async function full() {
  let owner = "";
  let created = false;
  let prNumber = 0;
  /** What this run actually wrote to an existing repository: cleanup touches only these. */
  let wroteFiles = false;
  let madeBranch = false;
  try {
    const me = await fj("GET", "/user");
    owner = EXISTING ? (EXISTING.split("/")[0] ?? "") : me.login;
    if (EXISTING && (!owner || !REPO || EXISTING.split("/").length !== 2)) throw new Error("FORGEJO_SMOKE_REPO must be owner/name");
    log(`==> ${ORIGIN} as ${me.login}${REVIEWER_TOKEN ? " (with a second reviewer account)" : " (single account: self-review refusals only)"}`);

    if (EXISTING) {
      // The script commits to the default branch, so never to a repository that is not clearly a scratch one.
      const info = await fj("GET", `/repos/${owner}/${REPO}`);
      const problems = [
        info.private === true || ALLOW_PUBLIC ? "" : "it is not private (set FORGEJO_SMOKE_ALLOW_PUBLIC=1 to use a public scratch repository)",
        String(info.name).startsWith("plannotator-smoke") ? "" : 'its name does not start with "plannotator-smoke"',
        info.permissions?.push === true ? "" : "the token cannot push to it",
        info.archived === true ? "it is archived" : "",
        info.empty === true ? "it is empty (create it with a README so it has a default branch)" : "",
        info.mirror === true ? "it is a mirror" : "",
      ].filter(Boolean);
      if (problems.length) throw new Error(`Refusing to use ${owner}/${REPO}: ${problems.join("; ")}.`);
      log(`==> Using the existing repository ${owner}/${REPO} (default branch ${info.default_branch}); it will not be deleted`);
      if (info.private !== true) log("    NOTE: the repository is public, so the commits and PR this run makes are public, and the attachment check below does not prove private access");
    } else {
      log(`==> Creating ${owner}/${REPO} (private)`);
      await fj("POST", "/user/repos", { name: REPO, private: true, auto_init: true, default_branch: "main", readme: "Default" });
      created = true;
    }
    const repo = `/repos/${owner}/${REPO}`;
    const repoInfo = await fj("GET", repo);
    const BASE = repoInfo.default_branch as string;
    const isPrivateRepo = repoInfo.private === true;

    log("==> Committing through the contents API and opening a PR");
    const blobSha = async (path: string, ref: string) => (await fj("GET", `${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`)).sha as string;
    const change = async (branch: string, message: string, files: unknown[], newBranch?: string) =>
      (await fj("POST", `${repo}/contents`, { branch, ...(newBranch ? { new_branch: newBranch } : {}), message, files })).commit.sha as string;
    wroteFiles = true;
    await change(BASE, "Base files", [
      { operation: "create", path: MATH_PATH, content: b64(MATH) },
      { operation: "create", path: NOTES_PATH, content: b64("old notes\n") },
    ]);
    const base = (await fj("GET", `${repo}/branches/${encodeURIComponent(BASE)}`)).commit.id as string;
    await change(BASE, "Add mul", [
      { operation: "update", path: MATH_PATH, sha: await blobSha(MATH_PATH, BASE), content: b64(`${MATH}\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n`) },
    ], BRANCH);
    madeBranch = true;
    await change(BRANCH, "Add greet, drop notes, add image", [
      { operation: "create", path: GREET_PATH, content: b64("export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n") },
      { operation: "delete", path: NOTES_PATH, sha: await blobSha(NOTES_PATH, BRANCH) },
      { operation: "create", path: PNG_PATH, content: b64(png) },
    ]);
    const head = (await fj("GET", `${repo}/branches/${encodeURIComponent(BRANCH)}`)).commit.id as string;
    const pr = await fj("POST", `${repo}/pulls`, {
      title: "Add mul and greet",
      body: "Live smoke PR for **Plannotator** Forgejo review.",
      head: BRANCH,
      base: BASE,
    });
    prNumber = pr.number;
    const prUrl = `${ORIGIN}/${owner}/${REPO}/pulls/${pr.number}`;
    const prApi = `${repo}/pulls/${pr.number}`;
    log(`    PR ${prUrl}  head=${head.slice(0, 12)}`);

    if (REVIEWER_TOKEN) {
      const reviewer = await fj("GET", "/user", undefined, REVIEWER_TOKEN);
      if (reviewer.login === me.login) throw new Error("The reviewer token belongs to the same account as the main token: Forgejo refuses reviewing your own PR, so use a different account.");
      if (EXISTING) {
        // Collaborators are the repository owner's to manage: only check that the reviewer can read it.
        await fj("GET", repo, undefined, REVIEWER_TOKEN).catch(() => {
          throw new Error(`The reviewer account ${reviewer.login} cannot see ${owner}/${REPO}: add it as a collaborator first.`);
        });
        log(`    reviewer ${reviewer.login} can read the repository`);
      } else {
        await fj("PUT", `${repo}/collaborators/${encodeURIComponent(reviewer.login)}`, { permission: "write" });
        log(`    reviewer ${reviewer.login} added as a collaborator`);
      }
    }

    log("==> Seeding comments, a two-comment inline thread and an attachment");
    await fj("POST", `${repo}/issues/${pr.number}/comments`, { body: "Seeded general comment." });
    // A reply is another inline comment on the same line in a new review, so two reviews make one thread.
    for (const text of ["Seeded inline comment.", "Seeded reply on the same line."]) {
      await fj("POST", `${prApi}/reviews`, { event: "COMMENT", body: "", commit_id: head, comments: [{ path: MATH_PATH, body: text, new_position: 9, old_position: 0 }] });
    }
    const upload = new FormData();
    upload.append("attachment", new Blob([png], { type: "image/png" }), "dot.png");
    const asset = await fj("POST", `${repo}/issues/${pr.number}/assets?name=dot.png`, upload);
    await fj("POST", `${repo}/issues/${pr.number}/comments`, { body: `Screenshot: ![dot.png](/attachments/${asset.uuid})` });

    log("==> Session 1: read everything, then post a comment review");
    const s1 = await startReview(prUrl, TOKEN, WITH_LOCAL);
    try {
      const diff = await getJson(s1, "/api/diff");
      const meta = diff.prMetadata ?? {};
      check("diff served for the Forgejo PR", meta.platform === "forgejo" && (diff.rawPatch.match(/^diff --git /gm) ?? []).length === 4, meta);
      check("metadata carries the full head sha", meta.headSha === head, { got: meta.headSha, head });
      check("merge base is the base branch tip", meta.mergeBaseSha === base, { got: meta.mergeBaseSha, base });
      check("author is the PR author's login", meta.author === me.login, meta.author);
      const pngEntry = diff.rawPatch.split(/^(?=diff --git )/m).find((chunk: string) => chunk.startsWith(`diff --git a/${PNG_PATH} b/${PNG_PATH}`)) ?? "";
      check("image file present as a binary stub", /^Binary files |^GIT binary patch/m.test(pngEntry), pngEntry.slice(0, 300) || "no entry for the image in the patch");
      const ctx = await getJson(s1, "/api/pr-context");
      check("seeded issue comment shown", ctx.comments?.some((c: any) => c.body === "Seeded general comment."), ctx.comments);
      const thread = ctx.reviewThreads?.find((t: any) => t.path === MATH_PATH && t.line === 9);
      check("seeded inline thread shown with its reply", thread?.diffSide === "RIGHT" && thread?.comments?.length === 2, thread);
      check("seeded reviews shown as comments", ctx.reviews?.filter((r: any) => r.state === "COMMENTED").length >= 2, ctx.reviews);
      const fc = await getJson(s1, `/api/file-content?path=${encodeURIComponent(MATH_PATH)}`);
      check("file content at the merge base and at head", !String(fc.oldContent).includes("mul") && String(fc.newContent).includes("mul"));
      const img = await fetch(`${s1.url}/api/review-image?path=${encodeURIComponent(PNG_PATH)}&side=new&snapshot=${encodeURIComponent(diff.snapshotId)}`);
      check("image preview bytes served", img.status === 200 && (img.headers.get("content-type") ?? "").includes("png"), img.status);
      const att = await fetch(`${s1.url}/api/pr-artifact-content?url=${encodeURIComponent(`${ORIGIN}/attachments/${asset.uuid}`)}`);
      check(isPrivateRepo ? "attachment of a PRIVATE repo served with the token" : "attachment served with the token (public repository: this does not prove private access)", att.status === 200 && (att.headers.get("content-type") ?? "").includes("png"), { status: att.status, body: att.status === 200 ? undefined : (await att.text()).slice(0, 200) });

      if (WITH_LOCAL) {
        let cwd: string | null = null;
        for (let i = 0; i < 120 && !cwd; i++) {
          await Bun.sleep(1000);
          cwd = (await getJson(s1, `/api/diff/fresh?snapshot=${encodeURIComponent(diff.snapshotId)}`)).agentCwd ?? null;
        }
        check("--local checkout became ready", !!cwd && existsSync(join(cwd!, GREET_PATH)), redact(s1.stderr()).slice(-600));
      }

      const comment = await prAction(s1, {
        action: "comment",
        body: "Smoke review: general comment.",
        fileComments: [
          { path: MATH_PATH, line: 10, side: "RIGHT", body: "Smoke inline (new side)." },
          { path: NOTES_PATH, line: 1, side: "LEFT", body: "Smoke inline (old side)." },
          { path: GREET_PATH, line: 3, side: "RIGHT", start_line: 1, start_side: "RIGHT", body: "Smoke multi-line." },
        ],
      });
      check("comment review submission complete", comment.status === 200 && comment.body.submission?.status === "complete", comment);

      // Your own PR: Forgejo answers 422 to both, and its reason must reach the caller.
      if (!REVIEWER_TOKEN) {
        const approve = await prAction(s1, { action: "approve", body: "", fileComments: [] });
        check("approving your own PR is refused, with Forgejo's reason", approve.status !== 200 && JSON.stringify(approve.body).includes("approve your own pull is not allowed"), approve);
        const reject = await prAction(s1, { action: "request_changes", body: "Smoke: own PR.", fileComments: [] });
        check("requesting changes on your own PR is refused, with Forgejo's reason", reject.status !== 200 && JSON.stringify(reject.body).includes("reject your own pull is not allowed"), reject);
      }
    } finally {
      await stopReview(s1);
    }

    const reviews = (await fj("GET", `${prApi}/reviews`)) as any[];
    const posted = reviews.find((r) => r.body === "Smoke review: general comment.");
    check("review on Forgejo is a comment review with the summary", posted?.state === "COMMENT", posted && { state: posted.state });
    const inline = posted ? ((await fj("GET", `${prApi}/reviews/${posted.id}/comments`)) as any[]) : [];
    const byBody = (raw: string) => inline.find((c) => c.body === raw);
    const newSide = byBody("Smoke inline (new side).");
    const oldSide = byBody("Smoke inline (old side).");
    const multi = byBody("Smoke multi-line.");
    check("inline new-side anchor", newSide?.path === MATH_PATH && newSide?.position === 10 && newSide?.original_position === 0, newSide && { position: newSide.position, original: newSide.original_position });
    // The provider READS position as the new-file line and original_position as the old-file line. This observes what
    // Forgejo returns for an old-side comment, which the provider's thread mapping assumes.
    check("inline old-side anchor", oldSide?.path === NOTES_PATH && oldSide?.position === 0 && oldSide?.original_position === 1, oldSide && { position: oldSide.position, original: oldSide.original_position });
    check("multi-line anchor", multi?.path === GREET_PATH && multi?.position === 1 && multi?.extra_lines_count === 2, multi && { position: multi.position, extra: multi.extra_lines_count });

    if (REVIEWER_TOKEN) {
      log("==> Session 2: approve as the reviewer");
      const s2 = await startReview(prUrl, REVIEWER_TOKEN, false);
      try {
        const ok = await prAction(s2, { action: "approve", body: "Smoke: looks good.", fileComments: [] });
        check("approve submission complete", ok.status === 200 && ok.body.submission?.status === "complete", ok);
        const ctx = await getJson(s2, "/api/pr-context");
        check("PR shows the approval", ctx.reviewDecision === "APPROVED", { decision: ctx.reviewDecision, reviews: ctx.reviews?.map((r: any) => r.state) });
      } finally {
        await stopReview(s2);
      }
      log("==> Session 3: request changes as the reviewer");
      const s3 = await startReview(prUrl, REVIEWER_TOKEN, false);
      try {
        const rc = await prAction(s3, { action: "request_changes", body: "Smoke: please add tests.", fileComments: [] });
        check("request-changes submission complete", rc.status === 200 && rc.body.submission?.status === "complete", rc);
        const ctx = await getJson(s3, "/api/pr-context");
        check("PR shows changes requested", ctx.reviewDecision === "CHANGES_REQUESTED", { decision: ctx.reviewDecision });
      } finally {
        await stopReview(s3);
      }
    }
  } catch (err) {
    failures++;
    log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (EXISTING && owner) {
      // An existing repository is never deleted: close the PR and drop the branch this run made.
      if (KEEP) {
        log(`==> Left ${owner}/${REPO} as is (FORGEJO_SMOKE_KEEP=1): PR #${prNumber} open, branch ${BRANCH}`);
      } else {
        const repo = `/repos/${owner}/${REPO}`;
        if (prNumber) await fj("PATCH", `${repo}/pulls/${prNumber}`, { state: "closed" }).then(() => log(`==> Closed PR #${prNumber}`), (err) => { failures++; log(`FAIL  could not close PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`); });
        if (madeBranch) await fj("DELETE", `${repo}/branches/${encodeURIComponent(BRANCH)}`).then(() => log(`==> Deleted branch ${BRANCH}`), (err) => log(`    (branch ${BRANCH} not deleted: ${err instanceof Error ? err.message : String(err)})`));
        if (wroteFiles) log(`==> ${owner}/${REPO} was not deleted: its files stay under ${DIR}/ on the default branch`);
      }
    } else if (created && !KEEP && REPO.startsWith("plannotator-smoke-")) {
    // Only the repo this run created, by name: nothing else is ever deleted.
      try {
        await fj("DELETE", `/repos/${owner}/${REPO}`);
        log(`==> Deleted ${owner}/${REPO}`);
      } catch (err) {
        failures++;
        log(`FAIL  could not delete ${owner}/${REPO}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (created) {
      log(`==> Kept ${owner}/${REPO} (FORGEJO_SMOKE_KEEP=1)`);
    }
  }
}

try {
  if (READONLY_PR) await readOnly(READONLY_PR);
  else if (WRITE) await full();
  else {
    log("==> Nothing run: the FULL mode creates, writes and deletes on the instance and needs FORGEJO_SMOKE_WRITE=1; set FORGEJO_SMOKE_READONLY_PR=<PR URL> for the read-only checks");
    process.exit(2);
  }
} catch (err) {
  failures++;
  log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
}
log(failures === 0 ? "==> All checks passed" : `==> ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
