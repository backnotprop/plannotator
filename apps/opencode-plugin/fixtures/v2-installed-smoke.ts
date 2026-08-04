import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

const [opencodeBin, pluginTarball] = Bun.argv.slice(2);
if (!opencodeBin || !pluginTarball) {
  throw new Error("Usage: bun fixtures/v2-installed-smoke.ts <opencode2-bin> <packed-plugin.tgz>");
}

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
const serverStdout = new Response(server.stdout).text();
const serverStderr = new Response(server.stderr).text();
let failed = false;

try {
  await waitForHealthyServer(url);
  const plugins = await waitForPlugin(url);
  console.log(JSON.stringify(plugins));
} catch (error) {
  failed = true;
  throw error;
} finally {
  server.kill();
  await server.exited;
  await registry.stop();
  const stdout = await serverStdout;
  const stderr = await serverStderr;
  if (failed) {
    console.error(stdout);
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
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, {
        headers: authHeaders(),
      });
      if (response.ok) return;
    } catch {
      // The server has not bound yet.
    }
    await Bun.sleep(50);
  }
  throw new Error("OpenCode 2 smoke server did not become healthy.");
}

async function waitForPlugin(url: string): Promise<unknown> {
  const deadline = Date.now() + 20_000;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const httpResponse = await fetch(`${url}/api/plugin`, {
      headers: {
        ...authHeaders(),
        "x-opencode-directory": encodeURIComponent(process.cwd()),
      },
    });
    lastOutput = await httpResponse.text();
    if (!httpResponse.ok) {
      throw new Error(`OpenCode plugin API returned ${httpResponse.status}: ${lastOutput}`);
    }
    const response = JSON.parse(lastOutput) as { data?: Array<{ id?: string } | string> };
    if (response.data?.some((plugin) =>
      typeof plugin === "string" ? plugin === "plannotator" : plugin.id === "plannotator"
    )) return response;
    await Bun.sleep(50);
  }
  throw new Error(`Plannotator did not activate in OpenCode 2. Last response: ${lastOutput}`);
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from("opencode:plannotator-smoke").toString("base64")}`,
  };
}
