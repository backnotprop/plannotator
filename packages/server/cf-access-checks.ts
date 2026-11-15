import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hasPlannotatorServerHeader } from "@plannotator/shared/plannotator-server-marker";
import { tunnelEnv } from "./cf-tunnel";
import { cleanLogLine, freeLoopbackPort, metricsArgs, readyConnections, REGISTERED_LINE } from "./cf-ready";

export type EdgeFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OutsideCheckInput {
  hosts: string[];
  team: string;
  port: number;
  binary: string;
  tokenFile: string;
  edgeFetch?: EdgeFetch;
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

export type OutsideCheckResult = { ok: true } | { ok: false; failure: string };

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function forgedToken(host: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "RS256", kid: randomBytes(8).toString("hex") })}.${b64({ email: "forged@example.com", aud: [randomBytes(16).toString("hex")], iss: `https://${host}`, exp: now + 3600, iat: now })}.${randomBytes(256).toString("base64url")}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toTeam(response: Response, team: string): boolean {
  if (response.status < 300 || response.status >= 400) return false;
  try {
    return new URL(response.headers.get("location") ?? "", "https://invalid.invalid").host.toLowerCase() === team;
  } catch {
    return false;
  }
}

async function waitConnected(child: ReturnType<typeof Bun.spawn>, metricsPort: number, timeoutMs: number): Promise<string | null> {
  const decoder = new TextDecoder();
  let last = "";
  let lastError = "";
  let registered = false;
  let exited = false;
  void child.exited.then(() => (exited = true));
  void (async () => {
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      for (const line of decoder.decode(chunk, { stream: true }).split("\n")) {
        if (!line.trim()) continue;
        if (REGISTERED_LINE.test(line)) registered = true;
        last = cleanLogLine(line);
        if (/\bERR\b|error/i.test(line)) lastError = last;
      }
    }
  })();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (registered || ((await readyConnections(metricsPort)) ?? 0) > 0) return null;
    if (exited) break;
    await sleep(500);
  }
  const seen = lastError || last;
  const said = seen ? ` Its last log line: "${seen}".` : " It printed nothing.";
  return exited
    ? `cloudflared stopped before it connected to Cloudflare.${said} Check that the tunnel still exists in the Cloudflare dashboard (Zero Trust, Networks, Tunnels) and that cloudflared is up to date (cloudflared --version).`
    : `cloudflared did not report a connection to Cloudflare within ${Math.round(timeoutMs / 1000)} s.${said} Check that this computer can reach Cloudflare (outbound UDP 7844, or TCP 443), that no firewall or VPN blocks it, and that cloudflared is up to date.`;
}

function loginMiss(url: string, team: string, seen: { status: number; location: string | null } | { error: string }): string {
  if ("error" in seen) return `${url} does not answer yet (${seen.error}). A new address can take a minute or two to appear; check that its DNS record exists in Cloudflare and is proxied (orange cloud).`;
  if (seen.status >= 300 && seen.status < 400) {
    return `A visit to ${url} without a sign-in was sent to ${seen.location ?? "nowhere"}, not to your Cloudflare Access login page at ${team}. Check that the Access application covers this name and that your Zero Trust team domain is ${team}.`;
  }
  if (seen.status === 401 || seen.status === 403) {
    return `A visit to ${url} without a sign-in got HTTP ${seen.status} instead of a redirect to your Cloudflare Access login page (${team}). Check in the Cloudflare dashboard (Zero Trust, Access, Applications) that an application covers this name with a sign-in method.`;
  }
  if (seen.status === 530 || seen.status === 502 || seen.status === 503 || seen.status === 504) {
    return `A visit to ${url} got HTTP ${seen.status}: Cloudflare could not reach the tunnel, or no Access application covers this name yet. Check the tunnel's status in the dashboard (Zero Trust, Networks, Tunnels).`;
  }
  return `A visit to ${url} without a sign-in got HTTP ${seen.status} instead of a redirect to your Cloudflare Access login page (${team}).`;
}

export async function runOutsideChecks(input: OutsideCheckInput): Promise<OutsideCheckResult> {
  const edge = input.edgeFetch ?? ((url, init) => fetch(url, init));
  const deadline = Date.now() + (input.timeoutMs ?? 90_000);
  let reached = 0;
  let recorder: ReturnType<typeof Bun.serve>;
  try {
    recorder = Bun.serve({
      hostname: "127.0.0.1",
      port: input.port,
      fetch: () => {
        reached += 1;
        return new Response("refused\n", { status: 403 });
      },
    });
  } catch {
    return { ok: false, failure: `port ${input.port} is in use; stop what holds it or pass --port.` };
  }
  const metricsPort = freeLoopbackPort();
  const child = Bun.spawn([input.binary, "tunnel", "--no-autoupdate", ...metricsArgs(metricsPort), "run"], {
    env: tunnelEnv(readFileSync(input.tokenFile, "utf8").trim()),
    windowsHide: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const notConnected = await waitConnected(child, metricsPort, input.connectTimeoutMs ?? 60_000);
    if (notConnected) return { ok: false, failure: notConnected };
    type Probe = { name: string; url: string; init: RequestInit; needsLogin: boolean };
    const probes: Probe[] = input.hosts.flatMap((host): Probe[] => {
      const url = `https://${host}/`;
      return [
        { name: `a visit to ${host} without a login`, url, init: { headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } }, needsLogin: true },
        { name: `a forged Access token at ${host}`, url, init: { headers: { "Cf-Access-Jwt-Assertion": forgedToken(input.team) } }, needsLogin: false },
        { name: `a forged Access cookie at ${host}`, url, init: { headers: { Cookie: `CF_Authorization=${forgedToken(input.team)}` } }, needsLogin: false },
        { name: `a wrong hostname at ${host}`, url, init: { headers: { Host: `wrong-${randomBytes(4).toString("hex")}.${host}` } }, needsLogin: false },
      ];
    });
    for (;;) {
      let pending: string | null = null;
      for (const probe of probes) {
        let response: Response;
        try {
          response = await edge(probe.url, { ...probe.init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
        } catch (error) {
          pending = loginMiss(probe.url, input.team, { error: error instanceof Error ? error.message : String(error) });
          break;
        }
        if (hasPlannotatorServerHeader(response.headers)) return { ok: false, failure: `${probe.name} reached Plannotator.` };
        if (response.status >= 200 && response.status < 300) return { ok: false, failure: `${probe.name} was let through (HTTP ${response.status}).` };
        if (probe.needsLogin && !toTeam(response, input.team)) {
          pending = loginMiss(probe.url, input.team, { status: response.status, location: response.headers.get("location") });
          break;
        }
      }
      if (!pending) break;
      if (Date.now() >= deadline) return { ok: false, failure: pending };
      await sleep(3_000);
    }
    await sleep(500);
    if (reached > 0) return { ok: false, failure: "a request without your login reached this computer." };
    return { ok: true };
  } finally {
    child.kill("SIGTERM");
    recorder.stop(true);
  }
}
