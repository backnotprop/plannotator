import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DOOR_SESSION_PREFIX } from "./cf-access";

export interface DoorSession {
  key: string;
  port: number;
  pid: number;
  secret: string;
}

export type DoorRoute =
  | { kind: "session"; key: string; path: string; via: "prefix" | "referer" }
  | { kind: "inbox" }
  | { kind: "ended" }
  | { kind: "wrong_origin" };

const KEY = /^[A-Za-z0-9_-]{16,64}$/;

export function newDoorToken(): string {
  return randomBytes(16).toString("base64url");
}

export function cfAccessDir(dataDir: string): string {
  return join(dataDir, "cloudflare-access");
}

function sessionsDir(dataDir: string): string {
  return join(cfAccessDir(dataDir), "sessions");
}

export function writeDoorSession(dataDir: string, session: DoorSession): void {
  const dir = sessionsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${session.key}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
  renameSync(tmp, file);
}

export function removeDoorSession(dataDir: string, key: string): void {
  if (!KEY.test(key)) return;
  rmSync(join(sessionsDir(dataDir), `${key}.json`), { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

export function readDoorSession(dataDir: string, key: string, alive: (pid: number) => boolean = pidAlive): DoorSession | null {
  if (!KEY.test(key)) return null;
  const file = join(sessionsDir(dataDir), `${key}.json`);
  if (!existsSync(file)) return null;
  let value: Partial<DoorSession>;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) as Partial<DoorSession>;
  } catch {
    return null;
  }
  const ok =
    value.key === key &&
    typeof value.secret === "string" &&
    value.secret.length >= 16 &&
    Number.isInteger(value.port) &&
    (value.port as number) >= 1 &&
    (value.port as number) <= 65535 &&
    Number.isInteger(value.pid) &&
    (value.pid as number) > 0;
  if (!ok) return null;
  if (!alive(value.pid as number)) {
    rmSync(file, { force: true });
    return null;
  }
  return value as DoorSession;
}

export function doorSecretMatches(expected: string, given: string | null): boolean {
  if (given === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

const INBOX_EXACT = new Set(["/", "/favicon.ico", "/favicon.png", "/favicon.svg", "/manifest.webmanifest", "/apple-touch-icon.png", "/mcp", "/api/shapes"]);
const INBOX_PREFIXES = ["/assets/", "/api/inbox/", "/api/ai/", "/api/shapes/", "/api/html-assets/"];

export function isInboxRoute(path: string): boolean {
  return INBOX_EXACT.has(path) || INBOX_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function sessionKeyOf(path: string): { key: string; rest: string } | null {
  if (!path.startsWith(DOOR_SESSION_PREFIX)) return null;
  const after = path.slice(DOOR_SESSION_PREFIX.length);
  const slash = after.indexOf("/");
  const key = slash < 0 ? after : after.slice(0, slash);
  if (!KEY.test(key)) return null;
  return { key, rest: slash < 0 ? "/" : after.slice(slash) };
}

export function doorSessionUrl(host: string, key: string): string {
  return `https://${host}${DOOR_SESSION_PREFIX}${key}/`;
}

export type DoorWorld = "inbox" | "sessions";

export function pickDoorRoute(
  world: DoorWorld,
  path: string,
  referer: string | null,
  sessionHost: string,
  live: (key: string) => boolean,
  navigate = false,
): DoorRoute {
  if (world === "inbox") return path.startsWith(DOOR_SESSION_PREFIX) ? { kind: "wrong_origin" } : { kind: "inbox" };
  if (path.startsWith(DOOR_SESSION_PREFIX)) {
    const own = sessionKeyOf(path);
    return own && live(own.key) ? { kind: "session", key: own.key, path: own.rest, via: "prefix" } : { kind: "ended" };
  }
  if (referer && !navigate) {
    let from: URL | null = null;
    try {
      from = new URL(referer);
    } catch {
      from = null;
    }
    const sameOrigin = from !== null && from.protocol === "https:" && from.host.toLowerCase() === sessionHost;
    const own = sameOrigin ? sessionKeyOf(from!.pathname) : null;
    if (own && live(own.key)) return { kind: "session", key: own.key, path, via: "referer" };
    if (own) return { kind: "ended" };
  }
  return isInboxRoute(path) ? { kind: "wrong_origin" } : { kind: "ended" };
}
