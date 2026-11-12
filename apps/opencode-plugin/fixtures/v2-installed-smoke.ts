import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { NATIVE_COMMANDS } from "../native-commands";

const [opencodeBin, pluginTarball] = Bun.argv.slice(2);
if (!opencodeBin || !pluginTarball) {
  throw new Error("Usage: bun fixtures/v2-installed-smoke.ts <opencode2-bin> <packed-plugin.tgz>");
}

const STATUS_ENDPOINTS = ["/api/info", "/api/health"] as const;
const HEALTH_TIMEOUT_MS = readTimeout("PLANNOTATOR_SMOKE_HEALTH_TIMEOUT_MS", 120_000);
const PLUGIN_TIMEOUT_MS = readTimeout("PLANNOTATOR_SMOKE_PLUGIN_TIMEOUT_MS", 300_000);
const REQUEST_TIMEOUT_MS = readTimeout("PLANNOTATOR_SMOKE_REQUEST_TIMEOUT_MS", 15_000);
const COMMAND_TIMEOUT_MS = readTimeout("PLANNOTATOR_SMOKE_COMMAND_TIMEOUT_MS", 30_000);
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

const stubsDir = path.join(root, "config", "opencode", "commands");
mkdirSync(stubsDir, { recursive: true });
const stubSource = path.join(import.meta.dir, "..", "commands");
for (const entry of readdirSync(stubSource)) {
  if (entry.endsWith(".md")) copyFileSync(path.join(stubSource, entry), path.join(stubsDir, entry));
}

const expectNativeCommands = process.env.PLANNOTATOR_SMOKE_EXPECT_NATIVE === "1";

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
  await checkCommands(url);
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
    const attempts: string[] = [];
    for (const endpoint of STATUS_ENDPOINTS) {
      try {
        const response = await fetch(`${url}${endpoint}`, {
          headers: authHeaders(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = (await response.text()).slice(0, 500);
        if (response.ok) {
          console.error(`healthy (${endpoint}) after ${elapsed()}`);
          return;
        }
        attempts.push(`${endpoint} HTTP ${response.status}: ${body}`);
      } catch (error) {
        attempts.push(`${endpoint} ${(error as Error).name}: ${(error as Error).message}`);
      }
    }
    lastSeen = attempts.join(" | ");
    if (Date.now() - lastReport >= PROGRESS_INTERVAL_MS) {
      lastReport = Date.now();
      console.error(`still waiting for ${STATUS_ENDPOINTS.join(" or ")} after ${elapsed()} — last: ${lastSeen}`);
    }
    await Bun.sleep(250);
  }
  throw new Error(
    `OpenCode 2 smoke server did not become healthy within ${HEALTH_TIMEOUT_MS}ms (waited ${elapsed()}). ` +
      `Last status result: ${lastSeen}`,
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
    const response = JSON.parse(lastOutput) as {
      data?: Array<
        | {
          id?: string;
          status?: string;
          error?: string;
          state?: { status?: string; error?: string };
        }
        | string
      >;
    };
    const entry = response.data?.find((plugin) =>
      typeof plugin === "string" ? plugin === "plannotator" : plugin.id === "plannotator"
    );
    if (entry) {
      const info = typeof entry === "string" ? undefined : entry;
      const status = info?.status ?? info?.state?.status;
      if (status === "failed") {
        const error = info?.error ?? info?.state?.error ?? "no error reported";
        throw new Error(`Plannotator activated as failed in OpenCode 2: ${error}`);
      }
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

interface CommandOwnership {
  body: string;
  missing: string[];
  shadowed: string[];
  owners: Array<{ name: string; native: boolean }>;
}

async function readCommandOwnership(url: string): Promise<CommandOwnership> {
  const response = await fetch(`${url}/api/command`, {
    headers: { ...authHeaders(), "x-opencode-directory": encodeURIComponent(process.cwd()) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`OpenCode command API returned ${response.status}: ${body}`);

  const commands = (JSON.parse(body) as { data?: Array<{ name?: string; description?: string }> }).data ?? [];
  const missing: string[] = [];
  const shadowed: string[] = [];
  const owners: Array<{ name: string; native: boolean }> = [];
  for (const command of NATIVE_COMMANDS) {
    const found = commands.find((entry) => entry.name === command.name);
    if (!found) {
      missing.push(command.name);
      continue;
    }
    const native = found.description === command.description;
    if (!native) shadowed.push(command.name);
    owners.push({ name: command.name, native });
  }
  return { body, missing, shadowed, owners };
}

async function checkCommands(url: string): Promise<void> {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  let lastReport = Date.now();
  let state = await readCommandOwnership(url);

  while (state.missing.length > 0 || (expectNativeCommands && state.shadowed.length > 0)) {
    if (Date.now() >= deadline) break;
    if (Date.now() - lastReport >= PROGRESS_INTERVAL_MS) {
      lastReport = Date.now();
      const pending = [...state.missing, ...(expectNativeCommands ? state.shadowed : [])];
      console.error(`still waiting for the command reclaim after ${elapsed()} — pending: ${pending.join(", ")}`);
    }
    await Bun.sleep(500);
    state = await readCommandOwnership(url);
  }

  for (const owner of state.owners) {
    console.error(`/${owner.name}: ${owner.native ? "plugin definition" : "markdown stub"}`);
  }

  if (state.missing.length > 0) {
    throw new Error(
      `OpenCode 2 resolved no command for: ${state.missing.join(", ")} within ${COMMAND_TIMEOUT_MS}ms ` +
        `(waited ${elapsed()}). Full list: ${state.body.slice(0, 800)}`,
    );
  }
  if (expectNativeCommands && state.shadowed.length > 0) {
    throw new Error(
      `The markdown stubs shadowed the plugin's native definitions for: ${state.shadowed.join(", ")} ` +
        `after ${COMMAND_TIMEOUT_MS}ms. ` +
        "The command names must be reclaimed after OpenCode's ConfigCommandPlugin activates.",
    );
  }
}

async function shutdown(): Promise<void> {
  server.kill();
  if (await withTimeout(server.exited.then(() => true), SHUTDOWN_TIMEOUT_MS, false) === false) {
    console.error("opencode2 ignored SIGTERM; sending SIGKILL");
    server.kill("SIGKILL");
    await withTimeout(server.exited.then(() => true), SHUTDOWN_TIMEOUT_MS, false);
  }
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
