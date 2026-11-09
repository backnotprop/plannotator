/**
 * `GET /api/ref` (the issue / PR / MR hover cards) on the plan, annotate and
 * review servers, driven over HTTP against real servers with a scripted
 * gh / glab runner (`refRunner`), never the real CLIs. Shared by the Bun suite
 * (ref-card-route.test.ts) and the Pi mirror
 * (apps/pi-extension/server/ref-card-route.test.ts), so both runtimes answer
 * the same scenarios.
 *
 * Covered: the card and its `serverSession`; refusals that run nothing (another
 * site, a Host this server does not answer, a url that is no such link, a
 * method other than GET); and the exposure rule: off in remote mode, and in a
 * `--tailscale` session where the runtime has one (Bun annotate and review) on
 * for a tab on this machine and the tailnet owner's tab through serve, off for
 * any other tailnet device. Requests go through node:http so Origin, Host,
 * Sec-Fetch-Site and the serve headers are exactly the ones under test. Every
 * test runs under a temp PLANNOTATOR_DATA_DIR.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import type { RefCli, RefCommandResult, RefRunner } from "@plannotator/shared/ref-cards";

export interface RefCardRouteServer {
  url: string;
  stop: () => void;
}

export type RefCardRouteKind = "plan" | "review" | "annotate";

export type StartRefCardRouteServer = (
  kind: RefCardRouteKind,
  options: { root: string; docPath: string; htmlContent: string; refRunner: RefRunner; tailnetPublished?: boolean },
) => Promise<RefCardRouteServer>;

const HTML = "<!doctype html><html><body>ref-card-route-app</body></html>";
const PR_URL = "https://github.com/acme/widgets/pull/12";

const FIRST_READ: Record<RefCardRouteKind, string> = { plan: "/api/plan", annotate: "/api/plan", review: "/api/diff" };

/** gh's answer for acme/widgets#12 (no avatar URL, so nothing is fetched from the network). */
const GITHUB_PR = {
  data: {
    repository: {
      nameWithOwner: "acme/widgets",
      issueOrPullRequest: {
        __typename: "PullRequest",
        number: 12,
        title: "Ship the widget",
        url: PR_URL,
        state: "OPEN",
        isDraft: false,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
        body: "Body",
        author: { login: "ada", avatarUrl: null },
        labels: { nodes: [] },
        assignees: { nodes: [] },
        comments: { totalCount: 0, nodes: [] },
        baseRefName: "main",
        headRefName: "widget",
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        reviewDecision: null,
        closingIssuesReferences: { nodes: [] },
        commits: { nodes: [] },
      },
    },
  },
};

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
}

function send(url: string, method: string, path: string, headers: Record<string, string>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, url), { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** A port nothing listens on right now (remote mode binds a fixed port). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A runtime with `--tailscale`: which servers have it, and how a test publishes
 * the session (the owner's login and the served URL, as the CLI records them)
 * and forgets it again.
 */
export interface RefCardRouteTailnet {
  kinds: RefCardRouteKind[];
  publish(owner: string, servedUrl: string): void;
  reset(): void;
}

const TAILNET_OWNER = "owner@example.com";
const TAILNET_NAME = "devbox.tail1234.ts.net";
const TAILNET_SERVED = `${TAILNET_NAME}:6060`;

export function defineRefCardRouteScenarios(
  runtime: string,
  start: StartRefCardRouteServer,
  options: { tailnet?: RefCardRouteTailnet } = {},
): void {
  const environment = createTestEnvironment(
    [
      "PLANNOTATOR_PORT",
      "PLANNOTATOR_REMOTE",
      "PLANNOTATOR_DATA_DIR",
      "PLANNOTATOR_BROWSER",
      "PLANNOTATOR_AI",
      "PLANNOTATOR_INBOX_CONNECT",
      "PLANNOTATOR_FEEDBACK_HISTORY",
      "PLANNOTATOR_ANNOTATE_HISTORY",
      "PLANNOTATOR_ALLOWED_HOSTS",
      "PLANNOTATOR_URL_HOST",
      "SSH_TTY",
      "SSH_CONNECTION",
    ],
    "plannotator-ref-card-route-",
  );

  let server: RefCardRouteServer | null = null;
  let host = "";
  let calls: Array<{ cli: RefCli; args: string[] }> = [];

  afterEach(() => {
    server?.stop();
    server = null;
    options.tailnet?.reset();
    environment.restore();
  });

  const run: RefRunner = async (cli, args) => {
    calls.push({ cli, args });
    const answer: RefCommandResult = args.includes("graphql")
      ? { stdout: JSON.stringify(GITHUB_PR), stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "not logged in", exitCode: 1 };
    return answer;
  };

  async function setUp(kind: RefCardRouteKind, mode: { remote?: boolean; tailnetPublished?: boolean } = {}): Promise<string> {
    environment.reset();
    calls = [];
    const dir = environment.makeTempDir();
    process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
    process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
    process.env.PLANNOTATOR_AI = "disabled";
    process.env.PLANNOTATOR_INBOX_CONNECT = "0";
    process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
    process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
    process.env.PLANNOTATOR_REMOTE = mode.remote ? "1" : "0";
    if (mode.remote) process.env.PLANNOTATOR_PORT = String(await freePort());
    const root = environment.makeTempDir();
    const docPath = join(root, "notes.md");
    writeFileSync(docPath, "# Notes\n\nSee https://github.com/acme/widgets/pull/12\n");
    server = await start(kind, { root, docPath, htmlContent: HTML, refRunner: run, tailnetPublished: mode.tailnetPublished });
    // Remote mode binds every interface: talk to it over loopback.
    const base = new URL(server.url);
    host = `127.0.0.1:${base.port}`;
    const first = (await (await fetch(`http://${host}${FIRST_READ[kind]}`)).json()) as { serverSession?: unknown };
    return typeof first.serverSession === "string" ? first.serverSession : "";
  }

  const get = (path: string, headers: Record<string, string> = {}) => send(`http://${host}`, "GET", path, { host, ...headers });
  const refPath = (href: string) => `/api/ref?url=${encodeURIComponent(href)}`;
  const queries = () => calls.filter((c) => c.args.includes("graphql"));

  describe(`${runtime}: GET /api/ref`, () => {
    for (const kind of ["plan", "annotate", "review"] as const) {
      test(`${kind}: answers the card with this server's session, read through gh with --hostname`, async () => {
        const serverSession = await setUp(kind);
        const card = await get(refPath(PR_URL), { origin: `http://${host}`, "sec-fetch-site": "same-origin" });
        expect(card.status).toBe(200);
        expect(card.headers["cache-control"]).toBe("no-store");
        expect(card.body).toMatchObject({ ok: true, serverSession, data: { title: "Ship the widget", number: 12, repo: "acme/widgets" } });
        expect(queries()).toHaveLength(1);
        const args = queries()[0].args;
        expect(queries()[0].cli).toBe("gh");
        expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
        // A second hover is the server's cache: nothing runs again.
        expect((await get(refPath(PR_URL))).status).toBe(200);
        expect(queries()).toHaveLength(1);
      });

      test(`${kind}: another site, a foreign Host, a url that is no ref, and a POST run nothing`, async () => {
        await setUp(kind);
        for (const foreign of <Record<string, string>[]>[
          { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
          { origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" },
          { "sec-fetch-site": "cross-site" },
          { origin: "null" },
        ]) {
          const refused = await get(refPath(PR_URL), foreign);
          expect(refused.status).toBe(403);
          expect(refused.body?.code).toBe("cross_origin");
        }
        // A name that is not this machine's: the Host allowlist answers before any route.
        const rebound = await send(`http://${host}`, "GET", refPath(PR_URL), { host: "attacker.example" });
        expect(rebound.status).toBe(403);
        expect(rebound.headers["x-plannotator-error"]).toBe("host_not_allowed");
        expect((await get(refPath("https://example.com/acme/widgets/pull/12"))).status).toBe(422);
        expect((await get(refPath(`https://github.com/acme/widgets/pull/12?${"x".repeat(2100)}`))).status).toBe(422);
        expect((await get("/api/ref")).status).toBe(422);
        expect((await send(`http://${host}`, "POST", refPath(PR_URL), { host })).status).toBe(405);
        expect(calls).toHaveLength(0);
      });

      test(`${kind}: remote mode turns it off, and nothing runs`, async () => {
        await setUp(kind, { remote: true });
        const off = await get(refPath(PR_URL));
        expect(off.status).toBe(404);
        expect(off.body?.code).toBe("ref_cards_disabled");
        expect(calls).toHaveLength(0);
      });
    }

    const tailnet = options.tailnet;
    for (const kind of tailnet?.kinds ?? []) {
      /** A request `tailscale serve` proxied from a tailnet device signed in as `login`. */
      const throughServe = (login: string, servedHost = TAILNET_SERVED) =>
        get(refPath(PR_URL), {
          host: servedHost,
          origin: `https://${servedHost}`,
          "sec-fetch-site": "same-origin",
          "tailscale-user-login": login,
          "x-forwarded-for": "100.64.0.9",
        });

      test(`${kind}: a --tailscale session answers a tab on this machine`, async () => {
        tailnet!.publish(TAILNET_OWNER, `https://${TAILNET_SERVED}`);
        const serverSession = await setUp(kind, { tailnetPublished: true });
        const card = await get(refPath(PR_URL), { origin: `http://${host}`, "sec-fetch-site": "same-origin" });
        expect(card.status).toBe(200);
        expect(card.body).toMatchObject({ ok: true, serverSession, data: { number: 12 } });
        expect(queries()).toHaveLength(1);
      });

      test(`${kind}: a --tailscale session answers the tailnet owner's tab through serve`, async () => {
        tailnet!.publish(TAILNET_OWNER, `https://${TAILNET_SERVED}`);
        await setUp(kind, { tailnetPublished: true });
        const card = await throughServe(TAILNET_OWNER);
        expect(card.status).toBe(200);
        expect(card.body).toMatchObject({ ok: true, data: { title: "Ship the widget" } });
        expect(queries()).toHaveLength(1);
      });

      test(`${kind}: a --tailscale session refuses every other tailnet device, and nothing runs`, async () => {
        tailnet!.publish(TAILNET_OWNER, `https://${TAILNET_SERVED}`);
        await setUp(kind, { tailnetPublished: true });
        for (const refused of [
          // Another login on the tailnet.
          await throughServe("someone-else@example.com"),
          // The owner's login, but not on the served name and port.
          await throughServe(TAILNET_OWNER, `${TAILNET_NAME}:7070`),
        ]) {
          expect(refused.status).toBe(404);
          expect(refused.body?.code).toBe("ref_cards_disabled");
        }
        // A tagged device (no login) and a funnel request are peers too.
        const tagged = await get(refPath(PR_URL), { host: TAILNET_SERVED, "x-forwarded-for": "100.64.0.9" });
        expect(tagged.status).toBe(404);
        const funnel = await get(refPath(PR_URL), {
          host: TAILNET_SERVED,
          "tailscale-user-login": TAILNET_OWNER,
          "tailscale-funnel-request": "?1",
          "x-forwarded-for": "203.0.113.7",
        });
        expect(funnel.status).toBe(404);
        expect(calls).toHaveLength(0);
      });

      test(`${kind}: with no owner on record, only this machine's tabs get cards`, async () => {
        tailnet!.publish("", `https://${TAILNET_SERVED}`);
        await setUp(kind, { tailnetPublished: true });
        expect((await throughServe(TAILNET_OWNER)).status).toBe(404);
        expect(calls).toHaveLength(0);
        expect((await get(refPath(PR_URL))).status).toBe(200);
      });
    }
  });
}
