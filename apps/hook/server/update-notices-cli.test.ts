/**
 * Update notices as real processes: a release-numbered CLI (`bun --define
 * __CLI_VERSION__`) runs `plannotator inbox` against a fake GitHub on
 * loopback. The release page (`/releases/latest`, a 302 to the tag) is the
 * source; the API answers 403 (its rate limit), as it can on a busy IP.
 *
 * The state on disk is the one that hid the notice before: an answer cached
 * a quarter of an hour ago naming the version this binary runs, and an API
 * rate-limit lockout hours long. The Update button must still show within seconds of the
 * Inbox starting, without the API being asked.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { type InboxEntry, inboxEntryOf, stopProvenInboxes } from "../../../tests/helpers/inbox-process";

const entry = resolve(import.meta.dir, "index.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeGitHub(latest: string) {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(`${req.method} ${path}`);
      if (path === "/r/p/releases/latest") return new Response(null, { status: 302, headers: { location: `/r/p/releases/tag/v${latest}` } });
      if (path === `/api/releases/tags/v${latest}`) {
        return Response.json({ tag_name: `v${latest}`, body: `## What's New in v${latest}\n\nThe release the page named.\n\n## Install / Update\n` });
      }
      // The API's own latest: rate limited.
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) },
      });
    },
  });
  return { requests, port: server.port, stop: () => server.stop(true) };
}

test("a new release shows in the Inbox within seconds of a start, through a stale cache and a rate-limited API", async () => {
  const stubs = stubHookDistHtml();
  cleanups.push(() => removeStubbedHtml(stubs));
  const root = mkdtempSync(join(tmpdir(), "plannotator-update-notices-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const gh = fakeGitHub("0.28.12");
  cleanups.push(gh.stop);

  const now = Date.now();
  writeFileSync(
    join(dataDir, "update-state.json"),
    JSON.stringify({
      latestRelease: { tag: "0.28.10", fetchedAt: now - 15 * 60 * 1000 },
      // What 0.28.30 wrote after a 403 from the API: no request for hours.
      releaseCheck: { attemptedAt: now - 12 * 60 * 1000, failedAt: now - 12 * 60 * 1000, error: "HTTP 403", retryAt: now + 5 * 60 * 60 * 1000 },
    }),
  );

  const proc = Bun.spawn(["bun", "--define", '__CLI_VERSION__="0.28.10"', entry, "inbox", "--no-open"], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_BROWSER,
      PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
      PLANNOTATOR_INSTALL_SCRIPT_URL: "http://127.0.0.1:9/install.sh",
      PLANNOTATOR_INBOX_PHONES: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      PLANNOTATOR_INBOX_TAILSCALE: "0",
      PLANNOTATOR_UPDATE_LATEST_URL: `http://127.0.0.1:${gh.port}/r/p/releases/latest`,
      PLANNOTATOR_UPDATE_API_URL: `http://127.0.0.1:${gh.port}/api/releases/latest`,
    },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  let inbox: InboxEntry | null = null;
  cleanups.push(async () => {
    if (inbox) await stopProvenInboxes([{ entry: inbox, root }]);
    await proc.exited;
  });

  const deadline = Date.now() + 30_000;
  while (!inbox && Date.now() < deadline) {
    await Bun.sleep(100);
    inbox = inboxEntryOf(dataDir);
  }
  expect(inbox).not.toBeNull();
  const started = Date.now();
  let update: { state?: string; version?: string } | null = null;
  while (Date.now() - started < 10_000) {
    const health = (await (await fetch(`http://127.0.0.1:${inbox!.port}/api/inbox/health`)).json()) as { update: typeof update };
    update = health.update;
    if (update) break;
    await Bun.sleep(100);
  }
  expect(update).toMatchObject({ state: "available", version: "0.28.12" });
  expect(Date.now() - started).toBeLessThan(5_000);
  // The page answered; the rate-limited API's latest was never asked.
  expect(gh.requests).toContain("HEAD /r/p/releases/latest");
  expect(gh.requests).not.toContain("GET /api/releases/latest");
  const state = JSON.parse(readFileSync(join(dataDir, "update-state.json"), "utf-8"));
  expect(state.latestRelease.tag).toBe("0.28.12");
  expect(state.releaseCheck.source).toBe("page");
}, 60_000);
