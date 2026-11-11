/**
 * Hover cards for issue, pull request and merge request links, on Bun. The
 * fetch, parsers, cache and route live in `@plannotator/shared/ref-cards`
 * (vendored to Pi, which runs them through `nodeRefCliRunner`); this module
 * adds the Bun runner and makes it the default.
 */

import {
  createRefCards as createSharedRefCards,
  handleRefCardRoute,
  REF_CARD_ROUTE,
  REF_DRAIN_MS,
  REF_TIMEOUT_MS,
  refRunnerKill,
  type BitbucketRefReader,
  type RefCards,
  type RefRunner,
} from "@plannotator/shared/ref-cards";
import { fetchBbPRCard } from "@plannotator/shared/pr-provider";
import { prCommandRuntime } from "./pr";

import { childEnv } from "@plannotator/shared/child-env";
import { sessionTailnetAskAllowed } from "./session-tailnet";

export * from "@plannotator/shared/ref-cards";

/** Everything a stream gives until it ends, and a way to stop waiting for the rest. */
function drain(stream: ReadableStream<Uint8Array>): { done: Promise<void>; text: () => string; stop: () => void } {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const done = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        if (value) chunks.push(value);
      }
    } catch {
      // A stream we stopped, or that broke: what came before is kept.
    }
  })();
  return {
    done,
    text: () => Buffer.concat(chunks).toString("utf8"),
    stop: () => void reader.cancel().catch(() => undefined),
  };
}

/**
 * A runner with its own time limit (tests); `refCliRunner` is the real one. The deadline is hard (`refRunnerKill`):
 * the CLI and everything it started are ended (TERM, then KILL), and the answer comes at once, whatever the
 * processes do. A CLI that exits while something it started still holds its output gets `REF_DRAIN_MS` for the
 * rest, then that leftover is ended too.
 */
export function createBunRefCliRunner(timeoutMs: number = REF_TIMEOUT_MS): RefRunner {
  return (cli, args, env) => {
    // Its own process group (POSIX), so the deadline reaches a wrapper's child or a helper glab started.
    const group = process.platform !== "win32";
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([cli, ...args], {
        env: childEnv({ GH_PROMPT_DISABLED: "1", NO_COLOR: "1", NO_PROMPT: "1", ...env }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: group,
      });
    } catch {
      return Promise.resolve({ stdout: "", stderr: `${cli}: not found`, exitCode: 127 });
    }
    const out = drain(proc.stdout as ReadableStream<Uint8Array>);
    const err = drain(proc.stderr as ReadableStream<Uint8Array>);
    const end = () => refRunnerKill((signal) => (group ? process.kill(-proc.pid, signal) : proc.kill(signal)));
    return new Promise((resolve) => {
      let settled = false;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (exitCode: number, stderr?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (drainTimer) clearTimeout(drainTimer);
        out.stop();
        err.stop();
        resolve({ stdout: out.text(), stderr: stderr ?? err.text(), exitCode });
      };
      const deadline = setTimeout(() => {
        end();
        finish(1, `${cli}: timed out`);
      }, timeoutMs);
      void proc.exited.then((code) => {
        void Promise.all([out.done, err.done]).then(() => finish(code));
        drainTimer = setTimeout(() => {
          // Exited, but something it started still holds the pipes: answer with what came, and end that leftover.
          end();
          finish(code);
        }, REF_DRAIN_MS);
      });
    });
  };
}

/** The real CLIs, each with a hard time limit, no prompt, no color. */
export const refCliRunner: RefRunner = createBunRefCliRunner();

/** Bitbucket Cloud pull requests through the review app's provider and credentials (the Inbox passes it). */
export const bitbucketRefReader: BitbucketRefReader = (ref, signal) => fetchBbPRCard(prCommandRuntime, { platform: "bitbucket", host: "bitbucket.org", ...ref }, signal);

/** `createRefCards` with the Bun runner by default (tests pass their own). */
export function createRefCards(options: Partial<Parameters<typeof createSharedRefCards>[0]> = {}): ReturnType<typeof createSharedRefCards> {
  return createSharedRefCards({ ...options, run: options.run ?? refCliRunner });
}

/**
 * `GET /api/ref` on a Bun plan, annotate or review server (`handleRefCardRoute`),
 * or null for any other path. `enabled` is false in remote mode; a `--tailscale`
 * session passes a function that decides per request (`refCardsTailnetAllowed`).
 */
export async function refCardRouteResponse(
  req: Request,
  url: URL,
  cards: RefCards,
  options: { enabled: boolean | ((req: Request) => boolean); serverSession?: string },
): Promise<Response | null> {
  if (url.pathname !== REF_CARD_ROUTE) return null;
  const answer = await handleRefCardRoute(
    {
      method: req.method,
      href: url.searchParams.get("url"),
      origin: req.headers.get("origin"),
      host: url.host,
      secFetchSite: req.headers.get("sec-fetch-site"),
      enabled: typeof options.enabled === "function" ? options.enabled(req) : options.enabled,
    },
    cards,
  );
  const body = answer.status === 200 && options.serverSession ? { serverSession: options.serverSession, ...answer.body } : answer.body;
  return Response.json(body, { status: answer.status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Who gets hover cards in a session published with `--tailscale`: a tab on this
 * machine, and the tailnet owner's tab through `tailscale serve` with the served
 * name as Host (the gate "Ask this session" uses, `sessionTailnetAskAllowed`).
 * Every other device on the tailnet is refused, so it can never drive this
 * computer's gh / glab. The Host allowlist has already run for a local tab.
 */
export function refCardsTailnetAllowed(req: Request): boolean {
  return sessionTailnetAskAllowed(req, () => true);
}
