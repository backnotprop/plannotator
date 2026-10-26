/**
 * `plannotator update` when GitHub is difficult (QA item 30): it reads the
 * release page first and needs no API, and when it cannot check at all it
 * ends with the command that always works. Fake GitHub on loopback; no
 * network, no installer.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdateCommand, type UpdateCommandDeps } from "./update-command";
import { fetchLatestFromPage, fetchLatestRelease } from "@plannotator/shared/update-check";

let dataDir: string;
let out: string;
let err: string;
let installs: string[];
let server: ReturnType<typeof Bun.serve>;
let page: () => Response;
let apiRequests: number;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-cmd-stuck-"));
  out = "";
  err = "";
  installs = [];
  apiRequests = 0;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      if (new URL(req.url).pathname.startsWith("/api/")) {
        apiRequests++;
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      }
      return page();
    },
  });
});
afterEach(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${server.port}`;
function run(overrides: Partial<UpdateCommandDeps> = {}) {
  return runUpdateCommand([], {
    currentVersion: "0.28.30",
    dataDir,
    execPath: "/home/u/.local/bin/plannotator",
    platform: "linux",
    env: { HOME: "/home/u" },
    out: (t) => (out += t),
    err: (t) => (err += t),
    fetchReleasePage: () => fetchLatestFromPage(`${base()}/backnotprop/plannotator/releases/latest`),
    fetchRelease: () => fetchLatestRelease(`${base()}/api/repos/backnotprop/plannotator/releases/latest`),
    runInstaller: async (launch) => {
      installs.push(launch.version);
      return 0;
    },
    ...overrides,
  });
}

test("the API rate-limited: it installs from the release page's answer", async () => {
  page = () => new Response(null, { status: 302, headers: { location: `${base()}/backnotprop/plannotator/releases/tag/v0.28.32` } });
  expect(await run()).toBe(0);
  expect(installs).toEqual(["v0.28.32"]);
  expect(apiRequests).toBe(0);
});

test("neither source answers (a captive portal and a rate-limited API): exit 1 with the install command that always works", async () => {
  page = () => new Response("<html>Sign in</html>", { status: 200 });
  expect(await run()).toBe(1);
  expect(err).toContain("Could not ask GitHub for the latest release");
  expect(err).toContain("curl -fsSL https://plannotator.ai/install.sh | bash");
  expect(installs).toEqual([]);
});

test("on Windows the command is the PowerShell one", async () => {
  page = () => new Response("<html>Sign in</html>", { status: 200 });
  expect(await run({ platform: "win32", execPath: "C:\\Users\\u\\AppData\\Local\\plannotator\\plannotator.exe", env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" } })).toBe(1);
  expect(err).toContain("irm https://plannotator.ai/install.ps1 | iex");
});
