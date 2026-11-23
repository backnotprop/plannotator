import { rmSync } from "node:fs";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { readInboxRegistry, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { storedCfAccess } from "@plannotator/shared/inbox/cf-access";
import { createCfApi, normalizeCfSetupHostname, type CfApi, type CfSetupStep, type CfTeardownStep } from "@plannotator/shared/inbox/cf-access-api";
import { cloudflaredInstallHint, findCloudflared, tunnelTokenPath } from "@plannotator/server/cf-tunnel";
import { writeUrlQr } from "@plannotator/server/qr";
import type { EdgeFetch } from "@plannotator/server/cf-access-checks";
import { runCfAccessRemoveFlow, runCfAccessSetupFlow } from "@plannotator/server/cf-access-flow";

export const CF_ACCESS_USAGE = [
  "Usage:",
  "  plannotator inbox cloudflare-access setup --email <you@example.com> [--zone <domain>] [--hostname <name>] [--session-hostname <name>] [--account <id>] [--port <n>]",
  "  plannotator inbox cloudflare-access teardown [--local-only]",
  "  plannotator inbox cloudflare-access status [--json]",
  "",
  "Reach the Inbox, and sessions started with --cloudflare-access, from your other devices",
  "through your own Cloudflare account (Tunnel + Access), for your e-mail only.",
  "",
  "Needs: a domain on Cloudflare, Zero Trust turned on (the Free plan is enough), cloudflared",
  "installed, and an API token (read from CLOUDFLARE_API_TOKEN or asked for; never saved) with:",
  "  Account: Cloudflare Tunnel Edit, Access: Apps and Policies Edit,",
  "  Access: Organizations, Identity Providers, and Groups Edit; Zone: DNS Edit (your domain).",
  "",
  "setup      creates the login (one-time PIN), the tunnel, the Access application for --email,",
  "           and only then the DNS record; checks from outside that nothing gets in without",
  "           your login; then turns it on and prints the address.",
  "           --hostname names the Inbox. --session-hostname names review, annotate and last",
  "           sessions. Both names must be distinct and one level under the selected zone.",
  "           On first setup, the sessions name defaults to <inbox-label>-s.<zone>.",
  "           To change it later, run teardown first.",
  "teardown   turns it off, then deletes the DNS record, the Access application and the tunnel.",
  "           --local-only turns it off here without the token and lists what is left.",
  "status     what is set up, and whether the tunnel is connected.",
].join("\n");

export interface CfAccessCommandDeps {
  dataDir: string;
  json: boolean;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  env?: NodeJS.ProcessEnv;
  api?: (token: string) => CfApi;
  binary?: string | null;
  readToken?: () => Promise<string>;
  edgeFetch?: EdgeFetch;
  checkTimeoutMs?: number;
  connectTimeoutMs?: number;
  out?: (line: string) => void;
  err?: (line: string) => void;
  pickPort?: () => number;
}

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  return value && !value.startsWith("--") ? value : "";
}

async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return "";
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") process.exit(130);
        value = char === "\u007f" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port as number;
  server.stop(true);
  return port;
}

async function tellInbox(entry: InboxRegistryEntry | null): Promise<InboxRegistryEntry["cloudflare_access"] | null> {
  if (!entry) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/inbox/control/cloudflare-access`, {
      method: "POST",
      headers: { Authorization: `Bearer ${entry.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as { cloudflare_access?: InboxRegistryEntry["cloudflare_access"] } | null;
    return body?.cloudflare_access ?? null;
  } catch {
    return null;
  }
}

export function describeCfAccessRecord(record: NonNullable<InboxRegistryEntry["cloudflare_access"]>): string {
  if (!record.url) return `not open: ${record.error ?? "unknown"}`;
  const tunnel = record.tunnel;
  if (!tunnel) return record.url;
  const how = tunnel.state === "connected" ? `connected (${tunnel.connections})` : tunnel.state;
  return `${record.url} (tunnel: ${how}${tunnel.error && tunnel.state !== "connected" ? `; ${tunnel.error}` : ""})`;
}

const SETUP_LINES: Record<CfSetupStep, string> = {
  token: "API token: active",
  account: "Account: found",
  zone: "Zone",
  team: "Zero Trust team",
  idp: "Login: one-time PIN",
  tunnel: "Tunnel",
  ingress: "Tunnel route: this hostname only, everything else 404",
  app: "Access application: your e-mail only, 24 h sign-in",
  dns: "DNS records (created last)",
};

const TEARDOWN_LINES: Record<CfTeardownStep, string> = {
  dns: "DNS record: deleted",
  app: "Access application: deleted",
  connections: "Tunnel connections: closed",
  tunnel: "Tunnel: deleted",
};

export async function runCfAccessCommand(args: readonly string[], deps: CfAccessCommandDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const env = deps.env ?? process.env;
  const makeApi = deps.api ?? ((token: string) => createCfApi(token));
  const readToken = async () => env.CLOUDFLARE_API_TOKEN?.trim() || (await (deps.readToken ?? (() => promptHidden("Cloudflare API token (not saved): ")))());
  const sub = args[0];

  if (sub === "status") {
    const stored = storedCfAccess(loadConfig());
    const record = readInboxRegistry(deps.dataDir)?.cloudflare_access ?? null;
    if (deps.json) {
      out(JSON.stringify({ configured: Boolean(stored?.host), on: stored?.on === true, host: stored?.host ?? null, allow: stored?.allow ?? [], record }, null, 2));
      return 0;
    }
    if (!stored?.host) {
      out("Cloudflare Access: not set up. See plannotator inbox cloudflare-access --help.");
      return 0;
    }
    out(`Cloudflare Access: ${stored.on ? "on" : "off"}, https://${stored.host}/ for ${(stored.allow ?? []).join(", ")}`);
    if (record) out(`  ${describeCfAccessRecord(record)}`);
    return 0;
  }

  if (sub === "setup") {
    const email = flag(args, "--email");
    if (!email) {
      err("setup needs --email <the address you sign in with>: only that e-mail will get in.");
      return 2;
    }
    const sessionHostArg = flag(args, "--session-hostname");
    const wantedSessionHost = normalizeCfSetupHostname(sessionHostArg ?? "");
    if (sessionHostArg !== undefined && !wantedSessionHost) {
      err("--session-hostname needs a hostname.");
      return 2;
    }
    const binary = deps.binary === undefined ? findCloudflared(env) : deps.binary;
    if (!binary) {
      err(`cloudflared is not installed. ${cloudflaredInstallHint()}`);
      return 1;
    }
    const token = await readToken();
    if (!token) {
      err("No API token: set CLOUDFLARE_API_TOKEN or run setup in a terminal.");
      return 2;
    }
    const before = storedCfAccess(loadConfig());
    const wantedHost = normalizeCfSetupHostname(flag(args, "--hostname") ?? "");
    if (before?.host && (before.tunnel || before.app || before.dnsRecord) && wantedHost && wantedHost !== before.host) {
      err(`Already set up for ${before.host}. Run plannotator inbox cloudflare-access teardown first, then set up ${wantedHost}.`);
      return 2;
    }
    if (before?.sessionHost && (before.tunnel || before.app || before.sessionDnsRecord) && wantedSessionHost && wantedSessionHost !== before.sessionHost) {
      err(`Sessions already use ${before.sessionHost}. Run plannotator inbox cloudflare-access teardown first, then set up ${wantedSessionHost}.`);
      return 2;
    }
    const portArg = flag(args, "--port");
    const port = portArg ? Number(portArg) : (before?.port ?? (deps.pickPort ?? freePort)());
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      err("--port must be from 1024 to 65535.");
      return 2;
    }
    const flow = await runCfAccessSetupFlow(
      { dataDir: deps.dataDir, api: makeApi(token), binary, apply: () => tellInbox(readInboxRegistry(deps.dataDir)), edgeFetch: deps.edgeFetch, checkTimeoutMs: deps.checkTimeoutMs, connectTimeoutMs: deps.connectTimeoutMs },
      { email, port, account: flag(args, "--account") || undefined, zone: flag(args, "--zone") || undefined, hostname: wantedHost || before?.host || undefined, sessionHostname: wantedSessionHost || undefined },
      (step, state) => {
        if (step === "checks" && state === "running") err("  Checking from outside that nothing gets in without your login…");
      },
      (step, detail) => err(`  ${SETUP_LINES[step]}${detail ? `: ${detail}` : ""}`),
    );
    if (!flow.ok) {
      err(`Not turned on (${flow.step}): ${flow.message}`);
      err(flow.leftover.length > 0 ? `Could not remove what setup made; delete in Cloudflare: ${flow.leftover.join(", ")}.` : "Nothing was left behind in Cloudflare.");
      return 1;
    }
    const after = (await tellInbox(await deps.ensureRunning().catch(() => null))) ?? null;
    const url = `https://${flow.host}/`;
    out(url);
    writeUrlQr(url);
    if (after?.error) err(`The Inbox could not open it yet: ${after.error}`);
    err(`On. Open it on your device and sign in with ${email.trim().toLowerCase()}. Sessions: add --cloudflare-access to review, annotate or last; they open at https://${flow.sessionHost}/s/…`);
    return 0;
  }

  if (sub === "teardown") {
    const stored = storedCfAccess(loadConfig());
    if (!stored?.host && !stored?.tunnel) {
      out("Cloudflare Access: not set up.");
      return 0;
    }
    saveConfig({ inboxCloudflareAccess: { ...stored, on: false } });
    await tellInbox(readInboxRegistry(deps.dataDir));
    if (args.includes("--local-only")) {
      rmSync(tunnelTokenPath(deps.dataDir), { force: true });
      err("Off here. Left in Cloudflare (delete them in the dashboard, in this order):");
      if (stored.dnsRecord) err(`  DNS record for ${stored.host}`);
      if (stored.sessionDnsRecord) err(`  DNS record for ${stored.sessionHost}`);
      if (stored.app) err(`  Access application ${stored.app}`);
      if (stored.tunnel) err(`  Tunnel ${stored.tunnel}`);
      return 0;
    }
    const token = await readToken();
    if (!token) {
      err("No API token: set CLOUDFLARE_API_TOKEN, or use --local-only.");
      return 2;
    }
    const removed = await runCfAccessRemoveFlow({ dataDir: deps.dataDir, api: makeApi(token), apply: () => tellInbox(readInboxRegistry(deps.dataDir)) }, (step) => err(`  ${TEARDOWN_LINES[step]}`));
    if (!removed.ok) {
      err(`Teardown stopped: ${removed.message}`);
      return 1;
    }
    out("Cloudflare Access: removed. Revoke the API token in Cloudflare (My Profile, API Tokens) if you no longer need it.");
    return 0;
  }

  (sub === "--help" || sub === "-h" || sub === undefined ? out : err)(CF_ACCESS_USAGE);
  return sub === "--help" || sub === "-h" || sub === undefined ? 0 : 2;
}
