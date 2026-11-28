import type { PlannotatorConfig } from "../config";
import { tailnetFetchSiteAllowed } from "./tailnet";

export const CF_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
export const CF_EDGE_HEADERS = [CF_ACCESS_JWT_HEADER, "cf-connecting-ip", "cf-ray", "cf-access-authenticated-user-email", "cf-ipcountry", "cf-visitor"] as const;
export const DOOR_SECRET_HEADER = "plannotator-door";
export const CF_ACCESS_ENV = "PLANNOTATOR_INBOX_CF_ACCESS";

export interface CfAccessStored {
  on?: boolean;
  host?: string;
  sessionHost?: string;
  team?: string;
  aud?: string;
  allow?: string[];
  port?: number;
  account?: string;
  zone?: string;
  tunnel?: string;
  app?: string;
  dnsRecord?: string;
  sessionDnsRecord?: string;
}

export interface CfAccessSettings {
  team: string;
  issuer: string;
  aud: string;
  allow: string[];
  host: string;
  sessionHost: string | null;
  port: number;
}

export type CfAccessResolution =
  | { on: false; configured: boolean; settings: null; error: null }
  | { on: true; configured: true; settings: CfAccessSettings; error: null }
  | { on: true; configured: true; settings: null; error: string };

export function parseCfAccessEnv(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const v = env[CF_ACCESS_ENV]?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on") return true;
  if (v === "0" || v === "false" || v === "off" || v === "disabled") return false;
  return undefined;
}

export function storedCfAccess(config: PlannotatorConfig): CfAccessStored | null {
  const value = (config as { inboxCloudflareAccess?: unknown }).inboxCloudflareAccess;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as CfAccessStored) : null;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function isPublicDnsName(name: string): boolean {
  if (name.length > 253 || !name.includes(".")) return false;
  const labels = name.split(".");
  if (!labels.every((l) => LABEL.test(l))) return false;
  if (/^\d+$/.test(labels.at(-1)!)) return false;
  return !(name === "localhost" || name.endsWith(".localhost"));
}

export function normalizeCfAccessEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEmailAddress(email: string): boolean {
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email);
}

export function normalizeTeamDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
}

export function isTeamDomain(team: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(team);
}

export function parseCfAccessSettings(stored: CfAccessStored, forbiddenPort: (port: number) => boolean = () => false): CfAccessSettings | { error: string } {
  const team = typeof stored.team === "string" ? normalizeTeamDomain(stored.team) : "";
  if (!isTeamDomain(team)) return { error: "The team domain must look like myteam.cloudflareaccess.com." };
  const aud = typeof stored.aud === "string" ? stored.aud.trim() : "";
  if (!/^[A-Za-z0-9]{16,128}$/.test(aud)) return { error: "The Access application's AUD tag is missing or malformed." };
  const allowRaw = Array.isArray(stored.allow) ? stored.allow.filter((v): v is string => typeof v === "string") : [];
  const allow = [...new Set(allowRaw.map(normalizeCfAccessEmail).filter(Boolean))];
  if (allow.length === 0 || !allow.every(isEmailAddress)) return { error: "The allowlist must name at least one e-mail address." };
  const host = typeof stored.host === "string" ? stored.host.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!isPublicDnsName(host)) return { error: "The hostname must be a public name like inbox.example.com." };
  const sessionHost = typeof stored.sessionHost === "string" && stored.sessionHost.trim() !== "" ? stored.sessionHost.trim().toLowerCase().replace(/\.$/, "") : null;
  if (sessionHost !== null && (!isPublicDnsName(sessionHost) || sessionHost === host)) return { error: "The sessions' hostname must be a public name of its own; run setup again." };
  const port = typeof stored.port === "number" ? stored.port : NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: "The listener port must be from 1024 to 65535." };
  if (forbiddenPort(port)) return { error: `Port ${port} is kept for the Inbox's own use.` };
  return { team, issuer: `https://${team}`, aud, allow, host, sessionHost, port };
}

export function resolveCfAccess(
  config: PlannotatorConfig,
  env: NodeJS.ProcessEnv = process.env,
  forbiddenPort: (port: number) => boolean = () => false,
): CfAccessResolution {
  const stored = storedCfAccess(config);
  const configured = stored !== null && typeof stored.host === "string" && stored.host !== "";
  const fromEnv = parseCfAccessEnv(env);
  const on = configured && stored?.on === true && fromEnv !== false;
  if (!on || !stored) return { on: false, configured, settings: null, error: null };
  const parsed = parseCfAccessSettings(stored, forbiddenPort);
  return "error" in parsed
    ? { on: true, configured: true, settings: null, error: parsed.error }
    : { on: true, configured: true, settings: parsed, error: null };
}

export function isCfAccessHost(hostHeader: string | null, host: string): boolean {
  if (!hostHeader) return false;
  let value = hostHeader.trim().toLowerCase();
  if (value.endsWith(":443")) value = value.slice(0, -4);
  return value.replace(/\.$/, "") === host;
}

export function hasCfEdgeHeaders(headers: Headers): boolean {
  return CF_EDGE_HEADERS.some((name) => headers.has(name));
}

export const DOOR_SESSION_PREFIX = "/s/";
const SESSION_ENTRY = /^\/s\/[A-Za-z0-9_-]{16,64}\/?$/;

export function cfAccessFetchSiteAllowed(method: string, path: string, headers: Headers, sessions = false): boolean {
  if (!sessions) return tailnetFetchSiteAllowed(method, path, headers);
  const site = headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (site !== "cross-site" && site !== "same-site") return true;
  const read = method === "GET" || method === "HEAD";
  return read && headers.get("sec-fetch-mode")?.trim().toLowerCase() === "navigate" && SESSION_ENTRY.test(path);
}
