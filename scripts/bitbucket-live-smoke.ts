/**
 * Live smoke test for Bitbucket Cloud PR review. NOT run in CI.
 * Run through scripts/bitbucket-live-smoke.sh, which maps and checks the env.
 *
 * Against a real Bitbucket Cloud workspace it:
 *   1. creates a throwaway private repo (plannotator-smoke-<stamp>),
 *   2. commits a base and two feature commits through the REST API (/src, so
 *      no git push credentials are needed) and opens a PR,
 *   3. seeds an existing general comment and an inline comment on the PR,
 *   4. runs this checkout's `plannotator review <PR URL>` headlessly and checks
 *      the diff, the metadata and the seeded comments it serves,
 *   5. posts an inline + general review with Approve through /api/pr-action,
 *      then a second session posts Request changes, and verifies each through
 *      the Bitbucket API,
 *   6. optionally (BITBUCKET_SMOKE_LOCAL=1) waits for the --local checkout and
 *      (BITBUCKET_SMOKE_GUIDE=1) runs a Guided Review on the PR,
 *   7. deletes the repo (unless BITBUCKET_SMOKE_KEEP=1).
 *
 * The token is read from PLANNOTATOR_BITBUCKET_TOKEN and never printed: every
 * line this script writes goes through redact().
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "apps/hook/server/index.ts");
const API = (process.env.PLANNOTATOR_BITBUCKET_API_URL || "https://api.bitbucket.org/2.0").replace(/\/+$/, "");
const EMAIL = process.env.PLANNOTATOR_BITBUCKET_EMAIL ?? "";
const TOKEN = process.env.PLANNOTATOR_BITBUCKET_TOKEN ?? "";
const WS = process.env.BITBUCKET_SMOKE_WORKSPACE ?? "";
const PROJECT = process.env.BITBUCKET_SMOKE_PROJECT_KEY ?? "";
const KEEP = process.env.BITBUCKET_SMOKE_KEEP === "1";
const WITH_LOCAL = process.env.BITBUCKET_SMOKE_LOCAL === "1";
const WITH_GUIDE = process.env.BITBUCKET_SMOKE_GUIDE === "1";
const REPO = process.env.BITBUCKET_SMOKE_REPO ?? `plannotator-smoke-${Date.now().toString(36)}`;

function redact(s: string): string {
  let out = s;
  if (TOKEN) out = out.split(TOKEN).join("[REDACTED]");
  const basic = TOKEN ? btoa(`${EMAIL}:${TOKEN}`) : "";
  if (basic) out = out.split(basic).join("[REDACTED]");
  return out;
}
const log = (...parts: unknown[]) => console.log(redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")));
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined && !ok ? `  ${JSON.stringify(detail)}` : ""}`);
}

const authHeader = EMAIL ? `Basic ${btoa(`${EMAIL}:${TOKEN}`)}` : `Bearer ${TOKEN}`;
async function bb(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
      ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
    },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(redact(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`));
  return text ? JSON.parse(text) : null;
}

async function commit(branch: string, message: string, files: Record<string, string | Uint8Array | null>, parent?: string): Promise<string> {
  const fd = new FormData();
  fd.append("message", message);
  fd.append("branch", branch);
  if (parent) fd.append("parents", parent);
  for (const [p, c] of Object.entries(files)) {
    if (c === null) fd.append("files", p);
    else fd.append(p, new Blob([c]), p.split("/").pop());
  }
  await bb("POST", `/repositories/${WS}/${REPO}/src`, fd);
  const ref = await bb("GET", `/repositories/${WS}/${REPO}/refs/branches/${encodeURIComponent(branch)}`);
  return ref.target.hash;
}

interface Session { proc: ReturnType<typeof Bun.spawn>; url: string; dir: string; stderr: () => string }
async function startReview(prUrl: string, local: boolean): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-bb-smoke-"));
  const ready = join(dir, "ready.json");
  let stderr = "";
  const proc = Bun.spawn([process.execPath, CLI, "review", prUrl, ...(local ? [] : ["--no-local"])], {
    cwd: dir,
    env: {
      ...process.env,
      PLANNOTATOR_CWD: dir,
      PLANNOTATOR_DATA_DIR: join(dir, "data"),
      PLANNOTATOR_READY_FILE: ready,
      PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
      PLANNOTATOR_REMOTE: "0",
      // Git over HTTPS with an API token (the --local clone): the helper reads
      // the token from the environment at call time, so it never appears in
      // argv, a URL, or git config on disk.
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `credential.https://bitbucket.org.helper`,
      GIT_CONFIG_VALUE_0: `!f() { echo username=x-bitbucket-api-token-auth; echo "password=$PLANNOTATOR_BITBUCKET_TOKEN"; }; f`,
    },
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
async function prAction(s: Session, body: unknown) {
  const res = await fetch(`${s.url}/api/pr-action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}

const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n";

let created = false;
try {
  log(`==> Creating ${WS}/${REPO}`);
  await bb("POST", `/repositories/${WS}/${REPO}`, { scm: "git", is_private: true, ...(PROJECT ? { project: { key: PROJECT } } : {}) });
  created = true;

  log("==> Committing through the REST API and opening a PR");
  const base = await commit("main", "Initial commit", { "src/math.ts": MATH, "README.md": "# Smoke\n", "notes.txt": "old notes\n" });
  const c1 = await commit("feature/smoke", "Add mul", { "src/math.ts": `${MATH}\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n` }, base);
  const head = await commit("feature/smoke", "Add greet, drop notes, add image", {
    "src/greet.ts": "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
    "notes.txt": null,
    "dot.png": png,
  }, c1);
  const pr = await bb("POST", `/repositories/${WS}/${REPO}/pullrequests`, {
    title: "Add mul and greet",
    description: "Live smoke PR for **Plannotator** Bitbucket review.",
    source: { branch: { name: "feature/smoke" } },
    destination: { branch: { name: "main" } },
  });
  const prPath = `/repositories/${WS}/${REPO}/pullrequests/${pr.id}`;
  const prUrl: string = pr.links.html.href;
  log(`    PR ${prUrl}  head=${head.slice(0, 12)}`);

  log("==> Seeding existing comments");
  await bb("POST", `${prPath}/comments`, { content: { raw: "Seeded general comment." } });
  const seededInline = await bb("POST", `${prPath}/comments`, { content: { raw: "Seeded inline comment." }, inline: { path: "src/math.ts", to: 9 } });
  await bb("POST", `${prPath}/comments`, { content: { raw: "Seeded reply." }, parent: { id: seededInline.id } });

  log("==> Session 1: review, then approve with comments");
  const s1 = await startReview(prUrl, WITH_LOCAL);
  try {
    const diff = await (await fetch(`${s1.url}/api/diff`)).json() as any;
    check("diff served for the Bitbucket PR", diff.prMetadata?.platform === "bitbucket" && (diff.rawPatch.match(/^diff --git /gm) ?? []).length === 4, diff.prMetadata);
    check("metadata carries full head SHA", diff.prMetadata?.headSha === head, { got: diff.prMetadata?.headSha, head });
    check("image file present as a binary stub", /Binary files \/dev\/null and b\/dot\.png differ/.test(diff.rawPatch));
    const ctx = await (await fetch(`${s1.url}/api/pr-context`)).json() as any;
    check("existing general comment shown", ctx.comments?.some((c: any) => c.body === "Seeded general comment."), ctx.comments);
    const thread = ctx.reviewThreads?.find((t: any) => t.id === String(seededInline.id));
    check("existing inline thread shown with its reply", thread?.line === 9 && thread?.comments?.length === 2, thread);
    const fc = await (await fetch(`${s1.url}/api/file-content?path=src/math.ts`)).json() as any;
    check("file content at merge base and head", !String(fc.oldContent).includes("mul") && String(fc.newContent).includes("mul"));
    const img = await fetch(`${s1.url}/api/review-image?path=dot.png&side=new&snapshot=${encodeURIComponent(diff.snapshotId)}`);
    check("image preview bytes served", img.status === 200 && (img.headers.get("content-type") ?? "").includes("png"), img.status);

    if (WITH_LOCAL) {
      let cwd: string | null = null;
      for (let i = 0; i < 120 && !cwd; i++) {
        await Bun.sleep(1000);
        cwd = ((await (await fetch(`${s1.url}/api/diff/fresh?snapshot=${encodeURIComponent(diff.snapshotId)}`)).json()) as any).agentCwd ?? null;
      }
      check("--local checkout became ready", !!cwd && existsSync(join(cwd!, "src/greet.ts")), redact(s1.stderr()).slice(-600));
    }

    if (WITH_GUIDE) {
      const launch = await fetch(`${s1.url}/api/agents/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "guide", engine: process.env.BITBUCKET_SMOKE_GUIDE_ENGINE ?? "claude" }),
      });
      const job = (await launch.json() as any).job;
      check("guided review launched", launch.status === 201 || launch.status === 200, job);
      let status = "";
      for (let i = 0; i < 600 && job; i++) {
        await Bun.sleep(1000);
        const jobs = (await (await fetch(`${s1.url}/api/agents/jobs`)).json() as any).jobs as any[];
        status = jobs.find((j) => j.id === job.id)?.status ?? "";
        if (status === "done" || status === "failed" || status === "killed") break;
      }
      check("guided review finished", status === "done", status);
      if (status === "done") {
        const guide = await (await fetch(`${s1.url}/api/guide/${job.id}`)).json() as any;
        const files = new Set((guide.sections ?? []).flatMap((s: any) => (s.diffs ?? []).map((d: any) => d.path ?? d.file ?? JSON.stringify(d))));
        log(`    guide: "${guide.title}" — ${guide.sections?.length ?? 0} sections, ${files.size} files`);
        check("guide has sections", (guide.sections?.length ?? 0) > 0);
      }
    }

    const approve = await prAction(s1, {
      action: "approve",
      body: "Smoke review: general comment.",
      fileComments: [
        { path: "src/math.ts", line: 10, side: "RIGHT", body: "Smoke inline (new side)." },
        { path: "notes.txt", line: 1, side: "LEFT", body: "Smoke inline (old side)." },
        { path: "src/greet.ts", line: 3, side: "RIGHT", start_line: 1, start_side: "RIGHT", body: "Smoke multi-line." },
      ],
    });
    check("approve submission complete", approve.status === 200 && approve.body.submission?.status === "complete", approve);
  } finally {
    await stopReview(s1);
  }

  const after1 = await bb("GET", `${prPath}/comments?pagelen=100`);
  const byBody = (raw: string) => after1.values.find((c: any) => c.content?.raw === raw);
  check("general comment on Bitbucket", !!byBody("Smoke review: general comment.") && !byBody("Smoke review: general comment.").inline);
  check("inline new-side anchor", byBody("Smoke inline (new side).")?.inline?.to === 10 && byBody("Smoke inline (new side).")?.inline?.path === "src/math.ts", byBody("Smoke inline (new side).")?.inline);
  check("inline old-side anchor", byBody("Smoke inline (old side).")?.inline?.from === 1, byBody("Smoke inline (old side).")?.inline);
  check("multi-line anchor", byBody("Smoke multi-line.")?.inline?.start_to === 1 && byBody("Smoke multi-line.")?.inline?.to === 3, byBody("Smoke multi-line.")?.inline);
  const me = await bb("GET", "/user");
  const p1 = (await bb("GET", prPath)).participants.find((p: any) => p.user?.account_id === me.account_id);
  check("PR approved by the token's user", p1?.state === "approved" && p1?.approved === true, p1 && { state: p1.state, approved: p1.approved });

  log("==> Session 2: request changes");
  const s2 = await startReview(prUrl, false);
  try {
    const rc = await prAction(s2, { action: "request_changes", body: "Smoke: please add tests.", fileComments: [] });
    check("request-changes submission complete", rc.status === 200 && rc.body.submission?.status === "complete", rc);
  } finally {
    await stopReview(s2);
  }
  const p2 = (await bb("GET", prPath)).participants.find((p: any) => p.user?.account_id === me.account_id);
  check("PR shows changes requested by the token's user", p2?.state === "changes_requested", p2 && { state: p2.state });
} catch (err) {
  failures++;
  log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (created && !KEEP) {
    try {
      await bb("DELETE", `/repositories/${WS}/${REPO}`);
      log(`==> Deleted ${WS}/${REPO}`);
    } catch (err) {
      failures++;
      log(`FAIL  could not delete ${WS}/${REPO}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (created) {
    log(`==> Kept ${WS}/${REPO} (BITBUCKET_SMOKE_KEEP=1)`);
  }
}

log(failures === 0 ? "==> All checks passed" : `==> ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
