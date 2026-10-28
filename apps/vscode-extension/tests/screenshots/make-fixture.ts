/**
 * A scratch world for driving the Guides view in a real VS Code (headless,
 * through `code serve-web`): a git repository with a realistic change on a
 * branch, a FAKE `gh` that answers from canned JSON, and a script for the
 * FAKE ACP agent (tests/helpers/fake-acp-agent.ts). Nothing here talks to GitHub or
 * runs a real agent.
 *
 *   bun tests/screenshots/make-fixture.ts <scratch dir>
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: make-fixture.ts <scratch dir>");
const repo = join(root, "checkout-service");
rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "Dana", GIT_COMMITTER_EMAIL: "dana@example.com" } }).trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text.replace(/^\n/, ""));
};

git("init", "-q", "-b", "main");
git("config", "commit.gpgsign", "false");

// --- main: the code before the PR -------------------------------------------
write("package.json", `{ "name": "checkout-service", "private": true, "type": "module" }\n`);
write("tsconfig.json", `{ "compilerOptions": { "strict": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler" }, "include": ["src"] }\n`);
write("src/net/httpClient.ts", `
export interface HttpResponse { ok: boolean; status: number }
export const httpClient = {
  async post(url: string, body: unknown, opts: { headers: Record<string, string>; timeoutMs: number }): Promise<HttpResponse> {
    void url; void body; void opts;
    return { ok: true, status: 200 };
  },
};
`);
write("src/observability/logger.ts", `
export const logger = {
  info(msg: string, fields?: Record<string, unknown>) { void msg; void fields; },
  warn(msg: string, fields?: Record<string, unknown>) { void msg; void fields; },
};
`);
write("src/webhooks/types.ts", `
export interface WebhookJob {
  id: string;
  endpoint: string;
  payload: unknown;
  attempt: number;
}
`);
write("src/webhooks/sign.ts", `
import type { WebhookJob } from "./types";
export function signHeaders(job: WebhookJob): Record<string, string> {
  return { "x-signature": \`sha256=\${job.id}\` };
}
`);
write("src/webhooks/deliver.ts", `
import { httpClient } from "../net/httpClient";
import { logger } from "../observability/logger";
import { signHeaders } from "./sign";
import type { WebhookJob } from "./types";

export async function deliverWebhook(job: WebhookJob): Promise<void> {
  const res = await httpClient.post(job.endpoint, job.payload, {
    headers: signHeaders(job),
    timeoutMs: 10_000,
  });

  if (!res.ok) {
    logger.warn("webhook delivery failed", { id: job.id, status: res.status });
    throw new Error(\`delivery failed: \${res.status}\`);
  }
}
`);
write("src/queue/worker.ts", `
import { deliverWebhook } from "../webhooks/deliver";
import type { WebhookJob } from "../webhooks/types";

export interface Queue { push(job: WebhookJob, opts?: { delayMs?: number }): Promise<void> }

export async function processJob(queue: Queue, job: WebhookJob): Promise<void> {
  try {
    await deliverWebhook(job);
  } catch {
    await queue.push({ ...job, attempt: job.attempt + 1 });
  }
}
`);
write("src/config/schema.ts", `
export interface Config {
  webhooks: { timeoutMs: number };
}
export const defaults: Config = { webhooks: { timeoutMs: 10_000 } };
`);
write("src/db.ts", `
export const db = {
  insertInto(table: string) {
    void table;
    return { values: (v: unknown) => ({ onConflict: (f: unknown) => ({ execute: async () => { void v; void f; } }) }) };
  },
};
`);
write("README.md", "# checkout-service\n\nPayments checkout and webhook delivery.\n");
git("add", "-A");
git("commit", "-q", "-m", "checkout-service: webhook delivery");
const mainSha = git("rev-parse", "HEAD");

// --- the PR branch -----------------------------------------------------------
git("checkout", "-q", "-b", "feat/webhook-retries");
write("src/webhooks/retryPolicy.ts", `
import type { Config } from "../config/schema";

/** How often and how long a failed delivery is retried. */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  attemptTimeoutMs: number;
}

export function retryPolicyFrom(config: Config): RetryPolicy {
  return config.webhooks.retry;
}

/** Exponential backoff with full jitter, clamped to policy.maxDelayMs. */
export function computeBackoff(attempt: number, policy: RetryPolicy): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

/** 5xx and 429 are worth another try; everything else is final. */
export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}
`);
write("src/config/schema.ts", `
import type { RetryPolicy } from "../webhooks/retryPolicy";

export interface Config {
  webhooks: { timeoutMs: number; retry: RetryPolicy };
}

export const defaults: Config = {
  webhooks: {
    timeoutMs: 10_000,
    retry: { maxAttempts: 8, baseDelayMs: 500, maxDelayMs: 300_000, attemptTimeoutMs: 10_000 },
  },
};
`);
write("src/webhooks/deadLetter.ts", `
import { db } from "../db";
import type { WebhookJob } from "./types";

export interface DeadLetterInfo {
  status: number;
  attempts: number;
}

export const deadLetters = {
  /** Idempotent: a job is dead-lettered at most once. */
  async put(job: WebhookJob, info: DeadLetterInfo): Promise<void> {
    await db
      .insertInto("webhook_dead_letters")
      .values({
        job_id: job.id,
        endpoint: job.endpoint,
        payload: JSON.stringify(job.payload),
        last_status: info.status,
        attempts: info.attempts,
      })
      .onConflict((oc: { column(c: string): { doNothing(): unknown } }) => oc.column("job_id").doNothing())
      .execute();
  },
};
`);
write("migrations/0042_webhook_dead_letters.sql", `
CREATE TABLE webhook_dead_letters (
  job_id      text PRIMARY KEY,
  endpoint    text NOT NULL,
  payload     jsonb NOT NULL,
  last_status integer NOT NULL,
  attempts    integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_dead_letters_created_at ON webhook_dead_letters (created_at DESC);
`);
write("src/webhooks/deliver.ts", `
import { httpClient } from "../net/httpClient";
import { logger } from "../observability/logger";
import { computeBackoff, isRetryable, type RetryPolicy } from "./retryPolicy";
import { deadLetters } from "./deadLetter";
import { signHeaders } from "./sign";
import type { WebhookJob } from "./types";

export type DeliveryOutcome =
  | { kind: "delivered"; attempts: number }
  | { kind: "retry"; delayMs: number; attempt: number }
  | { kind: "dead-lettered"; reason: string };

/** Sends one attempt and reports what should happen next. No longer throws on a bad status. */
export async function deliverWebhook(
  job: WebhookJob,
  policy: RetryPolicy,
): Promise<DeliveryOutcome> {
  const res = await httpClient.post(job.endpoint, job.payload, {
    headers: signHeaders(job),
    timeoutMs: policy.attemptTimeoutMs,
  });

  if (res.ok) return { kind: "delivered", attempts: job.attempt + 1 };

  const attempt = job.attempt + 1;
  if (!isRetryable(res.status) || attempt >= policy.maxAttempts) {
    await deadLetters.put(job, { status: res.status, attempts: attempt });
    logger.warn("webhook dead-lettered", { id: job.id, status: res.status });
    return { kind: "dead-lettered", reason: \`status \${res.status}\` };
  }
  return { kind: "retry", delayMs: computeBackoff(attempt, policy), attempt };
}
`);
write("src/queue/worker.ts", `
import { defaults } from "../config/schema";
import { deliverWebhook } from "../webhooks/deliver";
import { retryPolicyFrom } from "../webhooks/retryPolicy";
import type { WebhookJob } from "../webhooks/types";

export interface Queue { push(job: WebhookJob, opts?: { delayMs?: number }): Promise<void> }

export async function processJob(queue: Queue, job: WebhookJob): Promise<void> {
  const outcome = await deliverWebhook(job, retryPolicyFrom(defaults));
  if (outcome.kind === "retry") {
    await queue.push({ ...job, attempt: outcome.attempt }, { delayMs: outcome.delayMs });
  }
}
`);
write("src/webhooks/retryPolicy.test.ts", `
import { computeBackoff, isRetryable } from "./retryPolicy";

const policy = { maxAttempts: 8, baseDelayMs: 500, maxDelayMs: 300_000, attemptTimeoutMs: 10_000 };

export function testBackoffStaysUnderTheCeiling() {
  for (let a = 0; a < 20; a++) if (computeBackoff(a, policy) > policy.maxDelayMs) throw new Error("over");
}

export function testOnly5xxAnd429Retry() {
  if (!isRetryable(503) || !isRetryable(429) || isRetryable(404)) throw new Error("wrong");
}
`);
write("src/webhooks/deliver.test.ts", `
import { deliverWebhook } from "./deliver";

const policy = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10, attemptTimeoutMs: 100 };

export async function testDeliveredReturnsAnOutcome() {
  const out = await deliverWebhook({ id: "j1", endpoint: "https://example.test", payload: {}, attempt: 0 }, policy);
  if (out.kind !== "delivered") throw new Error(out.kind);
}
`);
git("add", "-A");
git("commit", "-q", "-m", "Retry failed webhook deliveries with backoff and a dead-letter table");
const prHead = git("rev-parse", "HEAD");

// Remote-tracking refs as if fetched from GitHub (no network is ever used).
git("remote", "add", "origin", "git@github.com:northwind/checkout-service.git");
git("update-ref", "refs/remotes/origin/main", mainSha);
git("update-ref", "refs/remotes/origin/feat/webhook-retries", prHead);
git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

// A little uncommitted work on top, for "Local changes".
write("src/webhooks/sign.ts", `
import type { WebhookJob } from "./types";

/** HMAC header the receiver checks. The attempt number lets receivers spot retries. */
export function signHeaders(job: WebhookJob): Record<string, string> {
  return { "x-signature": \`sha256=\${job.id}\`, "x-attempt": String(job.attempt + 1) };
}
`);

// --- the fake gh --------------------------------------------------------------
const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
const now = Date.now();
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
const prs = [
  { number: 482, title: "Retry failed webhook deliveries with backoff and a dead-letter table", url: "https://github.com/northwind/checkout-service/pull/482", author: { login: "ramos" }, isDraft: false, headRefName: "feat/webhook-retries", headRefOid: prHead, baseRefName: "main", additions: 127, deletions: 19, changedFiles: 8, updatedAt: iso(1), reviewRequests: [] },
  { number: 479, title: "Move signing secrets to KMS", url: "https://github.com/northwind/checkout-service/pull/479", author: { login: "dana" }, isDraft: false, headRefName: "feat/kms-signing", headRefOid: "1111111111111111111111111111111111111111", baseRefName: "main", additions: 64, deletions: 22, changedFiles: 6, updatedAt: iso(20), reviewRequests: [{ login: "ramos" }] },
  { number: 477, title: "Add idempotency keys to /charges", url: "https://github.com/northwind/checkout-service/pull/477", author: { login: "li" }, isDraft: false, headRefName: "feat/idempotency-keys", headRefOid: "2222222222222222222222222222222222222222", baseRefName: "main", additions: 211, deletions: 40, changedFiles: 9, updatedAt: iso(30), reviewRequests: [] },
  { number: 474, title: "Drop legacy v1 payloads", url: "https://github.com/northwind/checkout-service/pull/474", author: { login: "sam" }, isDraft: true, headRefName: "chore/drop-v1", headRefOid: "3333333333333333333333333333333333333333", baseRefName: "main", additions: 12, deletions: 380, changedFiles: 14, updatedAt: iso(60), reviewRequests: [] },
];
const waiting = [
  { number: 479, title: "Move signing secrets to KMS", url: "https://github.com/northwind/checkout-service/pull/479", repository: { nameWithOwner: "northwind/checkout-service" }, author: { login: "dana" }, updatedAt: iso(20), isDraft: false },
  { number: 214, title: "Keyboard nav for the filter bar", url: "https://github.com/northwind/ledger-ui/pull/214", repository: { nameWithOwner: "northwind/ledger-ui" }, author: { login: "ines" }, updatedAt: iso(5), isDraft: false },
  { number: 212, title: "Format currency per locale", url: "https://github.com/northwind/ledger-ui/pull/212", repository: { nameWithOwner: "northwind/ledger-ui" }, author: { login: "kofi" }, updatedAt: iso(40), isDraft: false },
];
const view482 = { number: 482, title: prs[0].title, url: prs[0].url, body: "Deliveries now retry with backoff; jobs that give up land in a dead-letter table.", author: { login: "ramos" }, headRefName: "feat/webhook-retries", headRefOid: prHead, baseRefName: "main", baseRefOid: mainSha };
writeFileSync(join(root, "gh-prs.json"), JSON.stringify(prs));
writeFileSync(join(root, "gh-waiting.json"), JSON.stringify(waiting));
writeFileSync(join(root, "gh-view-482.json"), JSON.stringify(view482));
writeFileSync(join(bin, "gh"), `#!/bin/sh
# FAKE gh for the Guides screenshots: canned answers, never the network.
D="${root}"
case "$1 $2" in
  "api user") echo ramos ;;
  "pr list") cat "$D/gh-prs.json" ;;
  "search prs") cat "$D/gh-waiting.json" ;;
  "pr view") if [ "$3" = "482" ]; then cat "$D/gh-view-482.json"; else echo "no such PR" >&2; exit 1; fi ;;
  *) echo "fake gh: unsupported: $*" >&2; exit 1 ;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);

// --- what the FAKE agent does ------------------------------------------------
const place = (file: string, chapter: string, summary: string, focus?: unknown[]) => ({ mcp: { name: "guide_place_file", args: { file, chapter, summary, ...(focus && { focus }) } } });
const agentScript = {
  // Like claude-agent-acp: a question about the guide loads the session that wrote it.
  loadSession: true,
  pace: Number(process.env.FAKE_AGENT_PACE ?? 700),
  steps: [
    { say: "I'll read the PR and the change first, then build the guide chapter by chapter." },
    { tool: { title: "Ran gh pr view 482 --json title,body,files", kind: "execute" } },
    { tool: { title: "Read src/webhooks/retryPolicy.ts", locations: [{ path: "src/webhooks/retryPolicy.ts" }] } },
    { tool: { title: "Read src/webhooks/deliver.ts", locations: [{ path: "src/webhooks/deliver.ts", line: 13 }] } },
    { mcp: { name: "guide_set_header", args: { title: "Retry failed webhook deliveries with backoff and a dead-letter table", intent: "Webhook delivery used to throw on any failure and the worker re-queued at once, so a flapping endpoint was hammered and a dead one retried forever. This PR gives every delivery a retry budget from config, backs off with jitter between attempts, and parks jobs that will never succeed in a new dead-letter table." } } },
    { mcp: { name: "guide_add_chapter", args: { title: "The retry budget", overview: "A new `RetryPolicy` says how many attempts a delivery gets and how long to wait between them. It lives in config, so operators tune it without a deploy. `computeBackoff` draws a delay with full jitter, capped at `maxDelayMs`." } } },
    { mcp: { name: "guide_add_chapter", args: { title: "Delivery loop learns to back off", overview: "`deliverWebhook` no longer throws on a bad status. It returns a `DeliveryOutcome`: delivered, retry after a delay from `computeBackoff`, or dead-lettered when the status is not retryable or the budget is spent.\n\n> [!IMPORTANT]\n> The attempt number is computed here as `job.attempt + 1` and incremented again by the worker when it re-queues (chapter 4). Check the two agree at the budget boundary." } } },
    place("src/webhooks/retryPolicy.ts", "c1", "Defines `RetryPolicy`, `computeBackoff` with full jitter, and `isRetryable` (5xx and 429)."),
    place("src/config/schema.ts", "c1", "Adds `webhooks.retry` to the config with the default budget: 8 attempts, 500 ms base, 5 min cap."),
    place("src/webhooks/deliver.ts", "c2", "Returns a `DeliveryOutcome` instead of throwing; dead-letters non-retryable statuses and spent budgets.", [{ start: 13, end: 37 }]),
    { tool: { title: "Read src/queue/worker.ts", locations: [{ path: "src/queue/worker.ts" }] } },
    { mcp: { name: "guide_add_chapter", args: { title: "Dead letters get a table", overview: "Jobs that give up are written to `webhook_dead_letters`. The insert ignores a duplicate `job_id`, so a worker that crashes after the insert and retries cannot write a second row." } } },
    place("src/webhooks/deadLetter.ts", "c3", "Idempotent insert keyed on `job_id`."),
    place("migrations/0042_webhook_dead_letters.sql", "c3", "New table plus a `created_at` index for the admin list."),
    { usage: { cost: 0.09 } },
    { mcp: { name: "guide_add_chapter", args: { title: "Worker schedules the retry", overview: "The worker reads the outcome and re-queues with the delay instead of right away. Delivered and dead-lettered jobs are done." } } },
    place("src/queue/worker.ts", "c4", "Re-queues with `delayMs` from the outcome; no more immediate retries."),
    { mcp: { name: "guide_add_chapter", args: { title: "Tests that pin the behavior", overview: "Unit tests for the backoff ceiling, the retryable statuses, and the delivered outcome." } } },
    place("src/webhooks/deliver.test.ts", "c2", "Checks a successful delivery returns the delivered outcome."),
    place("src/webhooks/deliver.test.ts", "c5", "Checks a successful delivery returns the delivered outcome."),
    { mcp: { name: "guide_move_file", args: { file: "src/webhooks/deliver.test.ts", chapter: "c5" } } },
    { mcp: { name: "guide_read" } },
    { tool: { title: "Reading src/webhooks/retryPolicy.test.ts", locations: [{ path: "src/webhooks/retryPolicy.test.ts" }] } },
    { sleep: Number(process.env.FAKE_AGENT_HOLD ?? 0) },
    place("src/webhooks/retryPolicy.test.ts", "c5", "Backoff never passes the ceiling; only 5xx and 429 retry."),
    { mcp: { name: "guide_set_overview", args: {
      text: "Before this PR, [deliverWebhook](symbol:deliverWebhook) threw on any failure and [processJob](symbol:processJob) re-queued at once. Now delivery returns an outcome. A retryable failure waits for [computeBackoff](symbol:computeBackoff) before the next attempt; a job that gives up lands in [webhook_dead_letters](code:migrations/0042_webhook_dead_letters.sql#L1). Short on time? Read [chapter 2](chapter:2) first.",
      diagram: { kind: "mermaid", source: [
        "flowchart LR",
        "  cfg[webhooks.retry config] --> pol[RetryPolicy]",
        "  w[Worker · processJob] -- calls --> del[deliverWebhook]",
        "  pol -. reads .-> del",
        "  del -- 2xx --> ok([delivered])",
        "  del -- retryable --> back[computeBackoff] --> rq[re-queue with delay]",
        "  rq -- next attempt --> w",
        "  del -- final --> dl[deadLetters.put] -- insert --> tbl[(webhook_dead_letters)]",
        '  click cfg "code:src/config/schema.ts#L9"',
        '  click pol "symbol:RetryPolicy"',
        '  click w "symbol:processJob"',
        '  click del "symbol:deliverWebhook"',
        '  click back "symbol:computeBackoff"',
        '  click dl "symbol:deadLetters"',
        '  click tbl "code:migrations/0042_webhook_dead_letters.sql#L1"',
      ].join("\n") },
    } } },
    { usage: { cost: 0.17 } },
    { mcp: { name: "guide_finish" } },
    { say: "The guide is saved: 5 chapters and an overview." },
  ],
};
// --- what the FAKE agent answers when asked (the ask session offers show_answer) ---
const box = (x: number, y: number, w: number, title: string, sub: string, color: string, link: string) =>
  `<g class="box" data-link="${link}" tabindex="0"><rect x="${x}" y="${y}" width="${w}" height="44" rx="6" fill="var(--card)" stroke="${color}" stroke-width="1.5"/>` +
  `<text x="${x + 12}" y="${y + 19}" font-family="var(--mono)" font-size="13" fill="var(--foreground)">${title}</text>` +
  `<text x="${x + 12}" y="${y + 35}" font-size="11.5" fill="var(--muted)">${sub}</text></g>`;
const arrow = (x1: number, y1: number, x2: number, y2: number) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--muted)" stroke-width="1.3" marker-end="url(#a)"/>`;
const answerHtml = `<style>
  .lead { font-size: 15px; font-weight: 600; margin: 0 0 12px; }
  .fig { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px 6px; margin: 0 0 14px; }
  .fig h4 { margin: 4px 0 6px; font-size: 11px; letter-spacing: .08em; color: var(--muted); }
  .box { cursor: pointer; } .box:hover rect { stroke-width: 2.5; }
  .note { font-size: 12px; color: var(--muted); margin: 2px 0 8px; }
  p { margin: 0 0 10px; } p.hl { background: color-mix(in srgb, var(--accent) 14%, transparent); border-radius: 4px; }
</style>
<div class="fig">
  <h4>BEFORE</h4>
  <svg viewBox="0 0 640 96" width="640">
    <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)"/></marker></defs>
    ${box(4, 6, 130, "post()", "any status", "var(--border)", "code:src/webhooks/deliver.ts#L18")}${arrow(136, 28, 160, 28)}
    ${box(162, 6, 140, "throw Error", "on non-2xx", "var(--del)", "code:src/webhooks/deliver.ts#L25")}${arrow(304, 28, 328, 28)}
    ${box(330, 6, 140, "processJob", "catch {…}", "var(--border)", "symbol:processJob")}${arrow(472, 28, 496, 28)}
    ${box(498, 6, 136, "queue.push(job)", "right away", "var(--del)", "code:src/queue/worker.ts#L1")}
    <path d="M566,52 L566,74 L70,74 L70,56" fill="none" stroke="var(--del)" stroke-dasharray="4 3" marker-end="url(#a)"/>
    <text x="318" y="90" text-anchor="middle" font-size="11.5" fill="var(--del)">back to the start: no delay, no limit, a 404 too</text>
  </svg>
  <h4>AFTER</h4>
  <svg viewBox="0 0 640 170" width="640">
    ${box(4, 62, 150, "deliverWebhook", "one attempt", "var(--chart-1)", "symbol:deliverWebhook")}${arrow(156, 84, 196, 84)}
    <g class="box" data-link="code:src/webhooks/deliver.ts#L26"><polygon points="244,62 290,84 244,106 198,84" fill="var(--card)" stroke="var(--chart-1)" stroke-width="1.5"/><text x="244" y="88" text-anchor="middle" font-size="12" fill="var(--foreground)">status?</text></g>
    ${arrow(290, 78, 360, 26)}${arrow(292, 84, 360, 84)}${arrow(290, 90, 360, 142)}
    <text x="300" y="40" font-size="11" fill="var(--muted)">2xx</text><text x="300" y="78" font-size="11" fill="var(--muted)">5xx · 429</text><text x="200" y="128" font-size="11" fill="var(--muted)">else, or 8th try</text>
    ${box(362, 4, 270, "delivered", "done; the worker does nothing", "var(--chart-3)", "code:src/webhooks/deliver.ts#L23")}
    ${box(362, 62, 270, "retry · computeBackoff(attempt)", "waits 0.5 s … 5 min, then queue.push", "var(--chart-2)", "symbol:computeBackoff")}
    ${box(362, 120, 270, "dead-lettered · deadLetters.put()", "kept once in webhook_dead_letters", "var(--chart-4)", "symbol:deadLetters")}
  </svg>
  <div class="note">Click a box to open its code.</div>
</div>
<p data-for="before">Before, <a href="symbol:deliverWebhook">deliverWebhook</a> threw on any bad status and <a href="symbol:processJob">processJob</a> caught it and pushed the job back at once: no delay, no limit. A receiver that was down for an hour got a retry every few milliseconds, and a <code>404</code> was retried forever.</p>
<p data-for="after">Lines <a href="code:src/webhooks/deliver.ts#L25-L31">25–31</a> replace the throw with a decision. A <code>5xx</code> or <code>429</code> with attempts left returns <code>retry</code> with a delay from <a href="symbol:computeBackoff">computeBackoff</a> (exponential, full jitter, capped at 5 minutes). Anything else, or the 8th failure, goes to <a href="symbol:deadLetters">deadLetters.put</a> and stops.</p>
<p>It returns a value instead of throwing because the worker now needs the delay: the outcome carries <code>delayMs</code>, and the worker hands it to <code>queue.push</code>. That half is <a href="chapter:4">Chapter 4 · Worker schedules the retry</a>.</p>
<script>
  // Hovering a picture highlights the paragraph that explains it.
  const figs = document.querySelectorAll(".fig svg");
  const para = (k) => document.querySelector('p[data-for="' + k + '"]');
  [["before", figs[0]], ["after", figs[1]]].forEach(([k, svg]) => {
    svg.addEventListener("mouseenter", () => para(k).classList.add("hl"));
    svg.addEventListener("mouseleave", () => para(k).classList.remove("hl"));
  });
</script>`;
(agentScript as Record<string, unknown>).askTurns = [[
  { say: "Before this change the loop retried every failure at once, with no delay and no cap. The new code turns the thrown error into a value the worker can act on" },
  { tool: { title: "Read src/queue/worker.ts", locations: [{ path: "src/queue/worker.ts" }] } },
  { tool: { title: "Read src/webhooks/retryPolicy.ts", locations: [{ path: "src/webhooks/retryPolicy.ts" }] } },
  { tool: { title: "Searched for processJob", kind: "search" } },
  { usage: { cost: 0.01 } },
  { sleep: Number(process.env.FAKE_AGENT_ASK_HOLD ?? 0) },
  { mcp: { name: "show_answer", args: { title: "Failures used to loop straight back. Now each one gets a decision.", html: answerHtml } } },
  { usage: { cost: 0.03 } },
  { say: "The answer is shown." },
]];
writeFileSync(join(root, "agent-script.json"), JSON.stringify(agentScript, null, 2));

console.log(JSON.stringify({ repo, bin, mainSha, prHead }));
