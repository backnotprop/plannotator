import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

const [opencodeBin, pluginTarball] = Bun.argv.slice(2);
if (!opencodeBin || !pluginTarball) {
  throw new Error("Usage: bun fixtures/v2-installed-smoke.ts <opencode2-bin> <packed-plugin.tgz>");
}

// OpenCode 2 installs the configured plugin through the throwaway registry below before the
// plugin
// can appear in /api/plugin, and it answers /api/health only once the server has finished
// booting. On a warm macOS dev box that is ~0.8s to healthy and ~6s to activated; on a cold
// Linux CI runner the measured numbers are ~9s and ~47s. These budgets are sized for the slow
// path with headroom — the job's own timeout is the real backstop against a genuine hang.
const HEALTH_TIMEOUT_MS = readTimeout("PLANNOTATOR_SMOKE_HEALTH_TIMEOUT_MS", 120_000);
const PLUGIN_TIMEOUT_MS = readTimeout("PLANNOTATOR_SMOKE_PLUGIN_TIMEOUT_MS", 300_000);
// Per-request cap so one wedged request can never swallow the whole budget: the loop has to
// keep polling (and keep reporting) instead of blocking on a single fetch that never settles.
const REQUEST_TIMEOUT_MS = readTimeout("PLANNOTATOR_SMOKE_REQUEST_TIMEOUT_MS", 15_000);
const SHUTDOWN_TIMEOUT_MS = 10_000;
const PROGRESS_INTERVAL_MS = 15_000;

const packageJson = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf-8")) as {
  name: string;
  version: string;
  [key: string]: unknown;
};
const root = mkdtempSync(path.join(tmpdir(), "plannotator-opencode-v2-smoke-"));
const port = await getFreePort();
const registryPort = await getFreePort();
const url = `http://127.0.0.1:${port}`;
const registryUrl = `http://127.0.0.1:${registryPort}`;
mkdirSync(path.join(root, "config"), { recursive: true });
mkdirSync(path.join(root, "data"), { recursive: true });
mkdirSync(path.join(root, "cache"), { recursive: true });

const env = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  OPENCODE_DB: path.join(root, "opencode.db"),
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    plugins: [{ package: `${packageJson.name}@${packageJson.version}`, options: { workflow: "plan-agent" } }],
  }),
  OPENCODE_LOG_LEVEL: "DEBUG",
  OPENCODE_PASSWORD: "plannotator-smoke",
  OPENCODE_SERVER_PASSWORD: "plannotator-smoke",
  NPM_CONFIG_REGISTRY: registryUrl,
  npm_config_registry: registryUrl,
};

const registry = Bun.serve({
  hostname: "127.0.0.1",
  port: registryPort,
  async fetch(request) {
    const requestUrl = new URL(request.url);
    const packageName = decodeURIComponent(requestUrl.pathname.slice(1));
    if (packageName === packageJson.name) {
      return Response.json({
        name: packageJson.name,
        "dist-tags": { latest: packageJson.version },
        versions: {
          [packageJson.version]: {
            ...packageJson,
            dist: { tarball: `${registryUrl}/plannotator-opencode.tgz` },
          },
        },
      });
    }
    if (requestUrl.pathname === "/plannotator-opencode.tgz") {
      return new Response(Bun.file(path.resolve(pluginTarball)));
    }

    const upstream = await fetch(`https://registry.npmjs.org${requestUrl.pathname}${requestUrl.search}`);
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  },
});

console.error(`opencode2 binary: ${opencodeBin} (${resolveOpencodeVersion()})`);
console.error(`plugin tarball: ${path.resolve(pluginTarball)}`);
console.error(`plugin package: ${packageJson.name}@${packageJson.version}`);
console.error(`server ${url} · throwaway registry ${registryUrl} · sandbox ${root}`);

const startedAt = Date.now();
const server = Bun.spawn([
  opencodeBin,
  "serve",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(port),
], {
  cwd: process.cwd(),
  env,
  stdout: "pipe",
  stderr: "pipe",
});
const serverStdout = new Response(server.stdout).text().catch((error) => `<stdout unavailable: ${error}>`);
const serverStderr = new Response(server.stderr).text().catch((error) => `<stderr unavailable: ${error}>`);
let failed = false;

try {
  await waitForHealthyServer(url);
  const plugins = await waitForPlugin(url);
  console.log(JSON.stringify(plugins));
} catch (error) {
  failed = true;
  throw error;
} finally {
  await shutdown();
  const stdout = await withTimeout(serverStdout, SHUTDOWN_TIMEOUT_MS, "<stdout drain timed out>");
  const stderr = await withTimeout(serverStderr, SHUTDOWN_TIMEOUT_MS, "<stderr drain timed out>");
  if (failed) {
    console.error(`--- opencode2 exit code: ${server.exitCode ?? "unknown"} ---`);
    console.error("--- opencode2 stdout ---");
    console.error(stdout);
    console.error("--- opencode2 stderr ---");
    console.error(stderr);
  }
  if (process.env.PLANNOTATOR_KEEP_SMOKE === "1") {
    console.error(`Smoke artifacts: ${root}`);
  } else {
    rmSync(root, { recursive: true, force: true });
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a smoke-test port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealthyServer(url: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastReport = Date.now();
  let lastSeen = "no response yet";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = (await response.text()).slice(0, 500);
      if (response.ok) {
        console.error(`healthy after ${elapsed()}`);
        return;
      }
      lastSeen = `HTTP ${response.status}: ${body}`;
    } catch (error) {
      lastSeen = `${(error as Error).name}: ${(error as Error).message}`;
    }
    if (Date.now() - lastReport >= PROGRESS_INTERVAL_MS) {
      lastReport = Date.now();
      console.error(`still waiting for /api/health after ${elapsed()} — last: ${lastSeen}`);
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `OpenCode 2 smoke server did not become healthy within ${HEALTH_TIMEOUT_MS}ms (waited ${elapsed()}). ` +
      `Last /api/health result: ${lastSeen}`,
  );
}

async function waitForPlugin(url: string): Promise<unknown> {
  const deadline = Date.now() + PLUGIN_TIMEOUT_MS;
  let lastReport = Date.now();
  let lastOutput = "";
  while (Date.now() < deadline) {
    let httpResponse: Response;
    try {
      httpResponse = await fetch(`${url}/api/plugin`, {
        headers: {
          ...authHeaders(),
          "x-opencode-directory": encodeURIComponent(process.cwd()),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastOutput = `${(error as Error).name}: ${(error as Error).message}`;
      await Bun.sleep(250);
      continue;
    }
    lastOutput = await httpResponse.text();
    if (!httpResponse.ok) {
      throw new Error(`OpenCode plugin API returned ${httpResponse.status}: ${lastOutput}`);
    }
    const response = JSON.parse(lastOutput) as { data?: Array<{ id?: string } | string> };
    if (response.data?.some((plugin) =>
      typeof plugin === "string" ? plugin === "plannotator" : plugin.id === "plannotator"
    )) {
      console.error(`plannotator activated after ${elapsed()}`);
      return response;
    }
    if (Date.now() - lastReport >= PROGRESS_INTERVAL_MS) {
      lastReport = Date.now();
      console.error(
        `still installing/activating the plugin after ${elapsed()} — ` +
          `${response.data?.length ?? 0} plugins registered so far`,
      );
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `Plannotator did not activate in OpenCode 2 within ${PLUGIN_TIMEOUT_MS}ms (waited ${elapsed()}). ` +
      `Last response: ${lastOutput}`,
  );
}

// A stuck teardown used to turn a failing smoke into a multi-minute CI wall-clock burn that
// hid the diagnostics behind the job timeout. Every step here is bounded and escalates.
async function shutdown(): Promise<void> {
  server.kill();
  if (await withTimeout(server.exited.then(() => true), SHUTDOWN_TIMEOUT_MS, false) === false) {
    console.error("opencode2 ignored SIGTERM; sending SIGKILL");
    server.kill("SIGKILL");
    await withTimeout(server.exited.then(() => true), SHUTDOWN_TIMEOUT_MS, false);
  }
  // `true` closes connections the in-flight plugin install may still be holding open.
  await withTimeout(Promise.resolve(registry.stop(true)), SHUTDOWN_TIMEOUT_MS, undefined);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return await Promise.race([promise, Bun.sleep(ms).then(() => fallback)]);
}

function resolveOpencodeVersion(): string {
  try {
    const result = Bun.spawnSync([opencodeBin, "--version"], { stdout: "pipe", stderr: "pipe" });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
    return output || `exit ${result.exitCode}`;
  } catch (error) {
    return `version lookup failed: ${(error as Error).message}`;
  }
}

function elapsed(): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function readTimeout(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from("opencode:plannotator-smoke").toString("base64")}`,
  };
}
