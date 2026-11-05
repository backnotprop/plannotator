/**
 * `plannotator review draw` and `plannotator review drawings`: an agent's
 * side of Show me (code review in the Inbox, approval "shape-in-code-review",
 * ac2). Every word it prints is AGENT-TEXT.md's, approved (q-b81e04bd), in core's inbox-review.ts.
 *
 *   plannotator review draw --file <drawing.json> --review <msg_id> --turn <turn_id>
 *   plannotator review drawings <msg_id>
 *
 * A thin client over the running Inbox (started detached when stopped):
 * `draw` POSTs the drawing to `/api/inbox/reviews/<msg>/drawings` with the
 * Inbox's token, where the server checks it (Shape's rules and the review's
 * files); `drawings` reads the same path. Off unless the person turned Code
 * review on (Settings → Capabilities): index.ts prints only
 * INBOX_REVIEW_CODE_REVIEW_OFF, help included, before this runs.
 *
 * stdout: the result. A refusal goes to stderr as `<code>: <message>` and
 * exits 1; bad usage exits 2.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  INBOX_REVIEW_CODE_REVIEW_OFF,
  INBOX_REVIEW_DRAW_HELP,
  INBOX_REVIEW_DRAW_SENT,
  inboxDrawingCodes,
  inboxReviewDrawingsLine,
  inboxReviewDrawRefusal,
  type InboxReviewDrawing,
} from "@plannotator/core/inbox-review";
import { isInboxId } from "@plannotator/core/inbox-types";
import { inboxHostSessionFromEnv } from "./inbox-mcp-shim";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";

export type ParsedReviewDrawCommand =
  | { ok: true; op: "help" }
  | { ok: true; op: "draw"; file: string; review: string; turn: string }
  | { ok: true; op: "drawings"; review: string }
  | { ok: false; error: string };

const HELP = new Set(["--help", "-h", "help"]);

/**
 * Whether argv (after `plannotator`) is one of these commands, by its shape:
 * `review draw` then --file, --review, --turn or --help; `review drawings`
 * then one review message id, or --help. Anything else (`review drawings`
 * alone, `review draw`, `review drawings ./dir`) is `plannotator review
 * <DIRECTORY | PR_URL>`, as it always was. Off (Code review off), never:
 * the review parse takes it, as in the release before Show me.
 * `codeReviewOn` is asked last, only for these two words: any other command
 * never reads config.json here (a broken one warns only where it always did).
 */
export function isReviewDrawCommand(argv: readonly string[], codeReviewOn: () => boolean): boolean {
  if (argv[0] !== "review" || (argv[1] !== "draw" && argv[1] !== "drawings")) return false;
  const first = argv[2];
  if (first === undefined) return false;
  const shaped =
    argv[1] === "draw"
      ? first === "--help" || first === "-h" || /^--(?:file|review|turn)(?:=|$)/.test(first)
      : first === "--help" || first === "-h" || isInboxId("msg", first);
  return shaped && codeReviewOn();
}

/** Parse the arguments after `review`: `draw --file F --review M --turn T`, or `drawings M`. */
export function parseReviewDrawCommand(argv: readonly string[]): ParsedReviewDrawCommand {
  const op = argv[0];
  const rest = argv.slice(1);
  if (rest.some((arg) => HELP.has(arg))) return { ok: true, op: "help" };
  if (op === "drawings") {
    if (rest.length !== 1 || rest[0]!.startsWith("-")) return { ok: false, error: "plannotator review drawings takes one review message id." };
    return { ok: true, op: "drawings", review: rest[0]! };
  }
  if (op !== "draw") return { ok: false, error: "A review drawing command: draw or drawings." };
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (name !== "--file" && name !== "--review" && name !== "--turn") return { ok: false, error: `Unknown argument: ${arg}` };
    const value = eq > 0 ? arg.slice(eq + 1) : rest[++i];
    if (value === undefined || value === "") return { ok: false, error: `${name} takes a value.` };
    if (flags[name] !== undefined) return { ok: false, error: `${name} is given twice.` };
    flags[name] = value;
  }
  const missing = ["--file", "--review", "--turn"].filter((name) => flags[name] === undefined);
  if (missing.length) return { ok: false, error: `plannotator review draw needs ${missing.join(", ")}.` };
  return { ok: true, op: "draw", file: flags["--file"]!, review: flags["--review"]!, turn: flags["--turn"]! };
}

export interface ReviewDrawCommandDeps {
  cwd: string;
  /** The environment: inside an agent host session, the drawing names that session (the turn's own). */
  env?: Record<string, string | undefined>;
  /** The running Inbox (started detached when stopped). */
  ensureRunning: () => Promise<InboxRegistryEntry>;
  fetch?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface Refusal {
  error?: string;
  code?: string;
  problems?: string[];
}

/** A refusal's line: the Inbox's own words, or AGENT-TEXT's for the codes it names. */
function refusalLine(body: Refusal, status: number, ids: { review: string; turn?: string }): string {
  const code = body.code ?? (status === 401 ? "unauthorized" : "failed");
  if (code === "code_review_off") return INBOX_REVIEW_CODE_REVIEW_OFF;
  if (code === "not_found") return `not_found: ${inboxReviewDrawRefusal.not_found(ids.review)}`;
  if (code === "not_a_review") return `not_a_review: ${inboxReviewDrawRefusal.not_a_review(ids.review)}`;
  if (code === "turn_unknown" && ids.turn) return `turn_unknown: ${inboxReviewDrawRefusal.turn_unknown(ids.turn)}`;
  if (code === "turn_stopped" && ids.turn) return `turn_stopped: ${inboxReviewDrawRefusal.turn_stopped(ids.turn)}`;
  if (code === "drawing_exists" && ids.turn) return `drawing_exists: ${inboxReviewDrawRefusal.drawing_exists(ids.turn)}`;
  if (code === "invalid" && Array.isArray(body.problems)) return `invalid: ${inboxReviewDrawRefusal.invalid(body.problems)}`;
  return `${code}: ${body.error ?? `the Inbox answered ${status}.`}`;
}

/** Run one review drawing command (Code review on); the exit code. */
export async function runReviewDrawCommand(argv: readonly string[], deps: ReviewDrawCommandDeps): Promise<number> {
  const out = deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const err = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const doFetch = deps.fetch ?? fetch;
  const parsed = parseReviewDrawCommand(argv);
  if (!parsed.ok) {
    err(`${parsed.error}\n\n${INBOX_REVIEW_DRAW_HELP}`);
    return 2;
  }
  if (parsed.op === "help") {
    out(INBOX_REVIEW_DRAW_HELP);
    return 0;
  }

  let drawing: unknown;
  if (parsed.op === "draw") {
    const path = isAbsolute(parsed.file) ? parsed.file : resolve(deps.cwd, parsed.file);
    try {
      drawing = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      err(`invalid: could not read ${path} as JSON: ${(error as Error).message}`);
      return 1;
    }
  }

  let entry: InboxRegistryEntry;
  try {
    entry = await deps.ensureRunning();
  } catch (error) {
    err(`inbox_unavailable: ${(error as Error).message}`);
    return 1;
  }
  const session = deps.env ? (inboxHostSessionFromEnv(deps.env)?.session ?? null) : null;
  const url = `http://127.0.0.1:${entry.port}/api/inbox/reviews/${encodeURIComponent(parsed.review)}/drawings`;
  const headers: Record<string, string> = { Authorization: `Bearer ${entry.token}` };
  let res: Response;
  try {
    res =
      parsed.op === "draw"
        ? await doFetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ turn: parsed.turn, drawing, ...(session ? { session } : {}) }) })
        : await doFetch(url, { headers });
  } catch (error) {
    err(`inbox_unavailable: ${(error as Error).message}`);
    return 1;
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    err(refusalLine(body as Refusal, res.status, { review: parsed.review, ...(parsed.op === "draw" ? { turn: parsed.turn } : {}) }));
    return 1;
  }
  if (parsed.op === "draw") {
    out(INBOX_REVIEW_DRAW_SENT);
    return 0;
  }
  const lines: string[] = [];
  const overview = body.overview as { round: number; codes: string[] } | null | undefined;
  if (overview) lines.push(inboxReviewDrawingsLine({ kind: "overview", round: overview.round, codes: overview.codes }));
  for (const d of (body.drawings as InboxReviewDrawing[] | undefined) ?? []) {
    lines.push(inboxReviewDrawingsLine({ kind: "show_me", round: d.round, file: d.file, lines: d.lines, codes: inboxDrawingCodes(d.view) }));
  }
  out(lines.length ? lines.join("\n") : "No drawings in this review.");
  return 0;
}
