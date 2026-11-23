import { randomBytes } from "node:crypto";
import { isEmailAddress, isPublicDnsName, isTeamDomain, normalizeCfAccessEmail, normalizeTeamDomain } from "./cf-access";

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
export const CF_TUNNEL_PREFIX = "plannotator-";
export const CF_APP_NAME = "Plannotator";
export const CF_DNS_COMMENT = "Plannotator through Cloudflare Access";

export class CfApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfApiError";
  }
}

export type CfFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CfApi {
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

export function createCfApi(token: string, options: { base?: string; fetch?: CfFetch } = {}): CfApi {
  const base = options.base ?? CLOUDFLARE_API_BASE;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      let response: Response;
      try {
        response = await doFetch(`${base}${path}`, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw new CfApiError(`${method} ${path.split("?")[0]}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const data = (await response.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { code?: number; message?: string }[] } | null;
      if (!data || data.success !== true) {
        const why = data?.errors?.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ") || `HTTP ${response.status}`;
        throw new CfApiError(`${method} ${redactIds(path.split("?")[0]!)} failed: ${why}`);
      }
      return data.result as T;
    },
  };
}

function redactIds(path: string): string {
  return path.replace(/\/[0-9a-f]{32}\b/g, "/<id>").replace(/\/[0-9a-f-]{36}\b/g, "/<id>");
}

export interface CfSetupInput {
  email: string;
  port: number;
  account?: string;
  zone?: string;
  hostname?: string;
  sessionHostname?: string;
}

export interface CfSetupResult {
  host: string;
  sessionHost: string;
  team: string;
  aud: string;
  account: string;
  zone: string;
  tunnel: string;
  app: string;
  dnsRecord: string;
  sessionDnsRecord: string;
  tunnelToken: string;
}

export type CfSetupStep = "token" | "account" | "zone" | "team" | "idp" | "tunnel" | "ingress" | "app" | "dns";

interface Named {
  id: string;
  name?: string;
}

interface AccessApplication extends Named {
  domain?: string;
  self_hosted_domains?: string[];
  destinations?: { type?: string; uri?: string }[];
}

const enc = encodeURIComponent;

export function normalizeCfSetupHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function hostnameInZone(host: string, zoneName: string): string {
  if (!isPublicDnsName(host) || !host.endsWith(`.${zoneName}`)) throw new CfApiError(`The hostname must be a name under ${zoneName}.`);
  if (host.split(".").length !== zoneName.split(".").length + 1) {
    throw new CfApiError(`Use a hostname one level under ${zoneName} (like plannotator.${zoneName}): Cloudflare's free certificate covers only that level.`);
  }
  return host;
}

export async function runCfSetup(
  api: CfApi,
  input: CfSetupInput,
  onStep: (step: CfSetupStep, detail?: string) => void = () => {},
  created: CfTeardownIds = {},
): Promise<CfSetupResult> {
  const email = normalizeCfAccessEmail(input.email);
  if (!isEmailAddress(email)) throw new CfApiError("--email must be the e-mail address you sign in with.");

  const verified = await api.call<{ status?: string }>("GET", "/user/tokens/verify");
  if (verified?.status !== "active") throw new CfApiError("The API token is not active.");
  onStep("token");

  const accounts = await api.call<Named[]>("GET", "/accounts?per_page=50");
  const account = input.account ? accounts.find((a) => a.id === input.account) : accounts.length === 1 ? accounts[0] : undefined;
  if (!account) throw new CfApiError(accounts.length === 0 ? "The token sees no Cloudflare account." : "The token sees several accounts; pass --account <id>.");
  const A = `/accounts/${account.id}`;
  created.account = account.id;
  onStep("account");

  const zones = await api.call<Named[]>("GET", `/zones?per_page=50&account.id=${enc(account.id)}`);
  const wanted = input.zone?.trim().toLowerCase();
  const fromHost = input.hostname === undefined ? undefined : normalizeCfSetupHostname(input.hostname);
  const zone =
    (wanted && zones.find((z) => z.name === wanted)) ||
    (!wanted && fromHost && zones.find((z) => fromHost.endsWith(`.${z.name}`))) ||
    (!wanted && !fromHost && zones.length === 1 ? zones[0] : undefined);
  if (!zone || !zone.name) throw new CfApiError(zones.length === 0 ? "The token sees no zone: a domain on Cloudflare is needed." : "Pass --zone <your domain> (the token sees several).");
  created.zone = zone.id;
  const host = hostnameInZone(fromHost ?? `plannotator-${randomBytes(3).toString("hex")}.${zone.name}`, zone.name);
  const sessionHost = input.sessionHostname === undefined
    ? `${host.split(".")[0]!.slice(0, 61)}-s.${zone.name}`
    : hostnameInZone(normalizeCfSetupHostname(input.sessionHostname), zone.name);
  if (sessionHost === host) throw new CfApiError("Use different hostnames for the Inbox and sessions.");
  onStep("zone", zone.name);

  const org = await api.call<{ auth_domain?: string }>("GET", `${A}/access/organizations`).catch(() => null);
  const team = org?.auth_domain ? normalizeTeamDomain(org.auth_domain) : "";
  if (!isTeamDomain(team)) throw new CfApiError("Zero Trust is not set up on this account: open the Cloudflare dashboard, Zero Trust, pick a team name and the Free plan, then run setup again.");
  onStep("team", team);

  const apps = await api.call<AccessApplication[]>("GET", `${A}/access/apps`);
  const appNames = (app: AccessApplication) => [
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations ?? []).flatMap(({ type, uri }) => (type === undefined || type === "public") && uri ? [uri] : []),
  ];
  const existing = apps.find((a) => a.name === CF_APP_NAME && (a.domain || a.self_hosted_domains?.[0]) === host);
  const other = apps.find((a) => a !== existing && [a.domain, ...appNames(a)].some((name) => name === host || name === sessionHost));
  if (other) throw new CfApiError(`An Access application named "${other.name}" already covers ${host} or ${sessionHost}; pick another hostname.`);
  if (existing && appNames(existing).some((name) => name !== host && name !== sessionHost)) {
    throw new CfApiError(`The Access application for ${host} already uses another sessions hostname.`);
  }

  const tunnelName = `${CF_TUNNEL_PREFIX}${host.split(".")[0]}`;
  const tunnels = await api.call<Named[]>("GET", `${A}/cfd_tunnel?is_deleted=false&name=${enc(tunnelName)}`);
  const reusedTunnel = tunnels.find((t) => t.name === tunnelName);
  const existingTarget = reusedTunnel ? `${reusedTunnel.id}.cfargotunnel.com` : null;
  const planned: { name: string; own?: Named }[] = [];
  for (const name of [host, sessionHost]) {
    const records = await api.call<(Named & { type?: string; content?: string })[]>("GET", `/zones/${zone.id}/dns_records?name=${enc(name)}`);
    const own = records.find((r) => r.type === "CNAME" && r.content === existingTarget);
    if (!own && records.length > 0) throw new CfApiError(`${name} already has a DNS record; pick another hostname.`);
    planned.push({ name, own });
  }

  const idps = await api.call<(Named & { type?: string })[]>("GET", `${A}/access/identity_providers`);
  const otp = idps.find((i) => i.type === "onetimepin") ?? (await api.call<Named>("POST", `${A}/access/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} }));
  onStep("idp");

  const tunnel = reusedTunnel ?? (await api.call<Named>("POST", `${A}/cfd_tunnel`, { name: tunnelName, config_src: "cloudflare" }));
  if (!reusedTunnel) created.tunnel = tunnel.id;
  const tokenResult = await api.call<string | { token?: string }>("GET", `${A}/cfd_tunnel/${tunnel.id}/token`);
  const tunnelToken = typeof tokenResult === "string" ? tokenResult : (tokenResult?.token ?? "");
  if (!tunnelToken) throw new CfApiError("Cloudflare returned no tunnel token.");
  onStep("tunnel", tunnelName);

  await api.call("PUT", `${A}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: {
      ingress: [
        { hostname: host, service: `http://127.0.0.1:${input.port}`, originRequest: { httpHostHeader: host } },
        { hostname: sessionHost, service: `http://127.0.0.1:${input.port}`, originRequest: { httpHostHeader: sessionHost } },
        { service: "http_status:404" },
      ],
    },
  });
  onStep("ingress");

  const appBody = {
    name: CF_APP_NAME,
    type: "self_hosted",
    domain: host,
    destinations: [host, sessionHost].map((uri) => ({ type: "public", uri })),
    session_duration: "24h",
    allowed_idps: [otp.id],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
    enable_binding_cookie: false,
    policies: [{ name: "owner only", decision: "allow", precedence: 1, include: [{ email: { email } }] }],
  };
  const app = existing
    ? await api.call<Named & { aud?: string }>("PUT", `${A}/access/apps/${existing.id}`, appBody)
    : await api.call<Named & { aud?: string }>("POST", `${A}/access/apps`, appBody);
  if (!existing) created.app = app.id;
  if (!app.aud) throw new CfApiError("Cloudflare returned no AUD tag for the Access application.");
  onStep("app");

  const target = `${tunnel.id}.cfargotunnel.com`;
  const made: string[] = [];
  for (const { name, own } of planned) {
    const record = { type: "CNAME", name, content: target, proxied: true, comment: CF_DNS_COMMENT };
    const dns = own
      ? await api.call<Named>("PUT", `/zones/${zone.id}/dns_records/${own.id}`, record)
      : await api.call<Named>("POST", `/zones/${zone.id}/dns_records`, record);
    made.push(dns.id);
    if (!own) {
      if (made.length === 1) created.dnsRecord = dns.id;
      else created.sessionDnsRecord = dns.id;
    }
  }
  onStep("dns", host);

  return { host, sessionHost, team, aud: app.aud, account: account.id, zone: zone.id, tunnel: tunnel.id, app: app.id, dnsRecord: made[0]!, sessionDnsRecord: made[1]!, tunnelToken };
}

export interface CfTeardownIds {
  account?: string;
  zone?: string;
  tunnel?: string;
  app?: string;
  dnsRecord?: string;
  sessionDnsRecord?: string;
}

export type CfTeardownStep = "dns" | "app" | "connections" | "tunnel";

export async function runCfTeardown(api: CfApi, ids: CfTeardownIds, onStep: (step: CfTeardownStep) => void = () => {}): Promise<void> {
  const gone = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof CfApiError) || !/\b(?:404|not found|1003|7003|81044)\b/i.test(error.message)) throw error;
    }
  };
  for (const record of [ids.dnsRecord, ids.sessionDnsRecord]) {
    if (!ids.zone || !record) continue;
    await gone(() => api.call("DELETE", `/zones/${ids.zone}/dns_records/${record}`));
    onStep("dns");
  }
  if (ids.account && ids.app) {
    await gone(() => api.call("DELETE", `/accounts/${ids.account}/access/apps/${ids.app}`));
    onStep("app");
  }
  if (ids.account && ids.tunnel) {
    await gone(() => api.call("DELETE", `/accounts/${ids.account}/cfd_tunnel/${ids.tunnel}/connections`));
    onStep("connections");
    await gone(() => api.call("DELETE", `/accounts/${ids.account}/cfd_tunnel/${ids.tunnel}`));
    onStep("tunnel");
  }
}
