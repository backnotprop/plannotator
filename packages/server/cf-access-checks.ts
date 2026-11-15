import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hasPlannotatorServerHeader } from "@plannotator/shared/plannotator-server-marker";
import { tunnelEnv } from "./cf-tunnel";

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

async function waitConnected(child: ReturnType<typeof Bun.spawn>, timeoutMs: number): Promise<string | null> {
  const decoder = new TextDecoder();
  let last = "";
  const read = (async () => {
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true });
      for (const line of text.split("\n")) {
        if (/Registered tunnel connection/.test(line)) return null;
        if (/\bERR\b|error/i.test(line)) last = line.replace(/[A-Za-z0-9_+/=-]{40,}/g, "[redacted]").slice(0, 200);
      }
    }
    return last || "cloudflared exited";
  })();
  const timeout = sleep(timeoutMs).then(() => last || "cloudflared did not connect in time");
  return Promise.race([read, timeout]);
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
  const child = Bun.spawn([input.binary, "tunnel", "--no-autoupdate", "run"], {
    env: tunnelEnv(readFileSync(input.tokenFile, "utf8").trim()),
    windowsHide: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const notConnected = await waitConnected(child, input.connectTimeoutMs ?? 60_000);
    if (notConnected) return { ok: false, failure: `the tunnel did not connect: ${notConnected}` };
    type Probe = { name: string; url: string; init: RequestInit; needsLogin: boolean };
    const probes: Probe[] = input.hosts.flatMap((host): Probe[] => {
      const url = `https://${host}/`;
      return [
        { name: `a visit to ${host} without a login`, url, init: {}, needsLogin: true },
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
        } catch {
          pending = `${probe.url} does not answer yet`;
          break;
        }
        if (hasPlannotatorServerHeader(response.headers)) return { ok: false, failure: `${probe.name} reached Plannotator.` };
        if (response.status >= 200 && response.status < 300) return { ok: false, failure: `${probe.name} was let through (HTTP ${response.status}).` };
        if (probe.needsLogin && !toTeam(response, input.team)) {
          pending = `Cloudflare Access is not asking for a login yet (HTTP ${response.status})`;
          break;
        }
      }
      if (!pending) break;
      if (Date.now() >= deadline) return { ok: false, failure: `${pending}. Wait a minute and run setup again.` };
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
