/**
 * "Ask your agent to look" (the errors system), the Inbox's side: what the
 * window cannot know when it writes the report for the person's agent
 * (`problemReport`, packages/core/problem-report.ts).
 *
 *   GET /api/inbox/problem-facts?cli=glab[&cli=gh][&host=<forge host>][&thread=<id>]
 *     → { plannotator, os, tools: [{ name, version, installed }], runs: [...], thread?: { session, link } }
 *
 * - `runs`: the newest failed runs of those tools (`createToolLog`, in memory
 *   only, never written anywhere): the command's name (never its arguments),
 *   the exit or the timeout, how long it ran, and the tool's last line,
 *   redacted here (`redactReportText`: home folder, tokens, emails, any host
 *   but the forge's own) before it leaves the Inbox.
 * - `tools`: `<cli> --version` (its own short deadline, cached 10 min), or
 *   `installed: false` when the tool is not there.
 * - `thread`: the agent session that owns the thread (the last agent that
 *   wrote in it, else the session a person's first message went to), so New
 *   message is addressed there, and the thread's loopback link.
 *
 * Read only when the person presses "Ask your agent to look". Bun only: the
 * Inbox has no Pi runtime.
 */

import { arch, homedir, release } from "node:os";
import { feedbackOsName } from "@plannotator/core/product-feedback";
import { redactReportText, type ProblemFacts, type ProblemToolRun } from "@plannotator/core/problem-report";
import type { InboxAuthor, InboxAddressee } from "@plannotator/core/inbox-types";
import type { RefCli, RefRunner } from "./ref-cards";
import { lastLineOf } from "@plannotator/shared/tool-state";

export const INBOX_PROBLEM_FACTS_PATH = "/api/inbox/problem-facts";

/** The most runs the log keeps (all tools together), and how many a report reads. */
export const TOOL_LOG_MAX = 60;
const FACTS_RUNS = 5;
const VERSION_MS = 3_000;
const VERSION_CACHE_MS = 10 * 60_000;

interface ToolLogEntry extends ProblemToolRun {
  cli: RefCli;
  host: string | null;
}

export interface ToolLog {
  add(entry: ToolLogEntry): void;
  /** The newest runs of `clis` (and of `host`, or naming no host), oldest first. */
  recent(clis: readonly RefCli[], host: string | null, n: number): ToolLogEntry[];
}

export function createToolLog(max = TOOL_LOG_MAX): ToolLog {
  const entries: ToolLogEntry[] = [];
  return {
    add(entry) {
      entries.push(entry);
      if (entries.length > max) entries.splice(0, entries.length - max);
    },
    recent(clis, host, n) {
      const h = host?.toLowerCase() ?? null;
      return entries.filter((e) => clis.includes(e.cli) && (h === null || e.host === null || e.host === h)).slice(-n);
    },
  };
}

/** A run's command, by name only: the subcommand words before the first option (`gh api graphql`, `glab auth status`). */
export function commandName(cli: string, args: readonly string[]): string {
  const words: string[] = [cli];
  for (const arg of args) {
    if (arg.startsWith("-") || words.length >= 3) break;
    // An endpoint or a query is an argument, not a command word.
    if (!/^[a-z][a-z-]*$/.test(arg)) break;
    words.push(arg);
  }
  return words.join(" ");
}

function hostArg(args: readonly string[]): string | null {
  const i = args.indexOf("--hostname");
  return i >= 0 && typeof args[i + 1] === "string" ? args[i + 1]!.toLowerCase() : null;
}

/**
 * The runner every forge read of the Inbox goes through, keeping each failed run in `log` (redacted at once, so the log
 * itself never holds a secret). `auth token` prints a token on success and its stdout is never read.
 */
export function recordingRunner(run: RefRunner, log: ToolLog, options: { now?: () => number; home?: string } = {}): RefRunner {
  const now = options.now ?? Date.now;
  const home = options.home ?? homedir();
  return async (cli, args, env) => {
    const started = now();
    const result = await run(cli, args, env);
    if (result.exitCode !== 0 || result.timedOut) {
      const host = hostArg(args);
      const tokenRead = args[0] === "auth" && args[1] === "token";
      const line = lastLineOf(result.stderr) ?? (tokenRead ? null : lastLineOf(result.stdout));
      log.add({
        cli,
        host,
        at: new Date(now()).toISOString(),
        command: commandName(cli, args),
        exit: result.timedOut ? null : result.exitCode,
        ms: now() - started,
        timed_out: result.timedOut === true || new RegExp(`^${cli}: timed out$`, "m").test(result.stderr),
        line: line ? redactReportText(line, { keepHosts: host ? [host] : [], home }).slice(0, 300) : null,
      });
    }
    return result;
  };
}

/** The agent session a thread belongs to: the last agent that wrote in it, else where a person's first message went. */
export function threadOwnerSession(messages: readonly { author: InboxAuthor; to?: InboxAddressee | null }[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const author = messages[i]!.author;
    if (author.kind === "agent" && author.session) return author.session;
  }
  return messages[0]?.to?.session ?? null;
}

export interface ProblemFactsStore {
  threadMessageIds(threadId: string): readonly string[];
  message(id: string): { author: InboxAuthor; to?: InboxAddressee | null } | null;
}

export function createProblemFacts(options: {
  version: string;
  run: RefRunner;
  log: ToolLog;
  store: ProblemFactsStore;
  json: (body: unknown, status?: number) => Response;
  /** The Inbox's loopback address (`http://localhost:<port>/`), read at each request. */
  baseUrl: () => string;
  platform?: string;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const versions = new Map<RefCli, { at: number; value: Promise<{ version: string | null; installed: boolean | null }> }>();
  const os = `${feedbackOsName(options.platform ?? process.platform)} ${release()} (${arch()})`;

  const versionOf = (cli: RefCli) => {
    const hit = versions.get(cli);
    if (hit && now() - hit.at < VERSION_CACHE_MS) return hit.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const value = Promise.race([
      options
        .run(cli, ["--version"])
        .then((r) => {
          if (r.exitCode === 127) return { version: null, installed: false };
          const found = /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(r.stdout.split("\n")[0] ?? "");
          return { version: found?.[1] ?? null, installed: r.exitCode === 0 ? true : null };
        })
        .catch(() => ({ version: null, installed: null })),
      new Promise<{ version: null; installed: null }>((resolve) => {
        timer = setTimeout(() => resolve({ version: null, installed: null }), VERSION_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    versions.set(cli, { at: now(), value });
    return value;
  };

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== INBOX_PROBLEM_FACTS_PATH) return null;
    if (req.method !== "GET") return options.json({ error: "Use GET." }, 405);
    const clis = [...new Set(url.searchParams.getAll("cli"))].filter((c): c is RefCli => c === "gh" || c === "glab");
    if (clis.length === 0) return options.json({ error: "cli: gh or glab.", code: "validation_error" }, 400);
    const host = url.searchParams.get("host")?.trim().toLowerCase() || null;
    const threadId = url.searchParams.get("thread");
    const tools = await Promise.all(clis.map(async (name) => ({ name, ...(await versionOf(name)) })));
    const runs: ProblemToolRun[] = options.log.recent(clis, host, FACTS_RUNS).map(({ cli: _cli, host: _host, ...run }) => run);
    let thread: { session: string | null; link: string } | undefined;
    if (threadId) {
      const ids = options.store.threadMessageIds(threadId);
      if (ids.length > 0) {
        const messages = ids.map((id) => options.store.message(id)).filter((m): m is NonNullable<typeof m> => m !== null);
        const base = options.baseUrl();
        thread = { session: threadOwnerSession(messages), link: base ? `${base.endsWith("/") ? base : `${base}/`}#thread=${threadId}` : "" };
      }
    }
    const facts: ProblemFacts & { thread?: typeof thread } = { plannotator: options.version, os, tools, runs, ...(thread ? { thread } : {}) };
    return options.json(facts);
  };

  return { route };
}
