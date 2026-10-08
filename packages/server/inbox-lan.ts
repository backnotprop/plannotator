/**
 * Plannotator Inbox: "Reach from this Wi-Fi" (adr/implementation/inbox-mobile.md,
 * section 3). Mounted by packages/server/inbox-devices.ts.
 *
 * While the switch is on, a TLS listener on every interface serves the
 * device door and nothing else (the same door-only handler the tailnet's
 * listener uses), on a port chosen free the first time and kept in inbox.json
 * as `lan: { port }`. The certificate is self-signed, made by `openssl` as a
 * child process the first time and kept in `inbox/tls/` (files 0600, the
 * directory 0700); the phone pins its SHA-256. A `_plannotator-inbox._tcp`
 * Bonjour record is published through `dns-sd -R` (macOS) or `avahi-publish`
 * (Linux) as a child process; where neither exists the listener still works
 * by typed address. Off, and at every clean stop, the listener and the
 * record go.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_BONJOUR_TYPE = "_plannotator-inbox._tcp";

export interface LanState {
  /** The person's switch, as inbox.json keeps it. */
  on: boolean;
  /** `ip:port` a phone on this network reaches, while the listener runs and the computer has a network address. */
  address: string | null;
  /** The certificate's SHA-256, 64 lowercase hex, while the listener runs. */
  fingerprint: string | null;
  /** The Bonjour record is published (1.3 lists it). False where neither `dns-sd` nor `avahi-publish` exists: the phone types the address. */
  bonjour: boolean;
  /** Why the listener is not working, in the window's words. */
  error: string | null;
}

export class LanUnavailableError extends Error {}

/** `inbox/tls/`: the certificate the phone pins and its key. */
export function inboxTlsDir(dataDir: string): string {
  return join(inboxDir(dataDir), "tls");
}

/** SHA-256 of the certificate's DER bytes, 64 lowercase hex (contract section 3). */
export function certificateFingerprint(pem: string): string {
  return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
}

/**
 * The certificate and key, made with `openssl` the first time: ECDSA P-256,
 * self-signed, `CN=Plannotator Inbox`, never rotated. Written inside a 0700
 * directory, then each file set to 0600. Throws LanUnavailableError when
 * `openssl` is missing or fails.
 */
export function ensureInboxCertificate(dataDir: string): { cert: string; key: string; fingerprint: string } {
  const dir = inboxTlsDir(dataDir);
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const run = (args: string[]) => spawnSync("openssl", args, { encoding: "utf8", timeout: 15_000, env: process.env });
    const made =
      [
        ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath],
        ["req", "-new", "-x509", "-key", keyPath, "-out", certPath, "-days", "36500", "-subj", "/CN=Plannotator Inbox"],
      ].every((args) => run(args).status === 0) && existsSync(certPath);
    if (!made) {
      rmSync(dir, { recursive: true, force: true });
      throw new LanUnavailableError("The Inbox could not make its certificate: openssl is missing or failed. Install OpenSSL, then turn Reach from this Wi-Fi on again.");
    }
    for (const path of [certPath, keyPath]) chmodSync(path, 0o600);
  }
  const cert = readFileSync(certPath, "utf8");
  return { cert, key: readFileSync(keyPath, "utf8"), fingerprint: certificateFingerprint(cert) };
}

/**
 * The address a phone on this network uses: the first IPv4 address of an
 * interface that is up, not loopback, not link-local (169.254/16) and not
 * Tailscale's (100.64/10), private ranges first. Null with no network.
 */
export function lanAddress(): string | null {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [a, b] = entry.address.split(".").map(Number) as [number, number];
      if (a === 169 && b === 254) continue;
      if (a === 100 && b >= 64 && b <= 127) continue;
      found.push(entry.address);
    }
  }
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return found.find(isPrivate) ?? found[0] ?? null;
}

/**
 * Publish the Bonjour record through `dns-sd -R` or `avahi-publish`, or
 * return null when neither exists. The publisher runs under `sh`, which ends
 * it when its stdin closes: on a clean stop (we close it) and when the Inbox
 * dies without one (the kernel closes it), so a crash leaves no record behind.
 */
function publishBonjour(name: string, port: number, fingerprint: string): ChildProcess | null {
  const txt = ["v=1", `fp=${fingerprint}`];
  const dnsSd = process.platform === "darwin" ? Bun.which("dns-sd") : null;
  const avahi = dnsSd ? null : Bun.which("avahi-publish");
  const command = dnsSd
    ? [dnsSd, "-R", name, INBOX_BONJOUR_TYPE, "local", String(port), ...txt]
    : avahi
      ? [avahi, "-s", name, INBOX_BONJOUR_TYPE, String(port), ...txt]
      : null;
  if (!command) return null;
  const child = spawn("/bin/sh", ["-c", '"$@" >/dev/null 2>&1 & child=$!; read _; kill "$child"', "sh", ...command], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.on("error", () => {});
  child.stdin?.on("error", () => {});
  child.unref();
  return child;
}

export interface InboxLanContext {
  dataDir: string;
  /** The port inbox.json kept, or null. */
  savedPort: () => number | null;
  /** Keep the switch in inbox.json: the port while on, null when off. */
  savePort: (port: number | null) => void;
  /** The computer's name: the Bonjour instance name. */
  name: () => string;
  /** The door, and nothing else (inbox-devices.ts `doorOnly`). */
  fetch: (req: Request) => Response | Promise<Response>;
}

export function createInboxLan(context: InboxLanContext) {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let bonjour: ChildProcess | null = null;
  let fingerprint: string | null = null;
  let on = false;
  let error: string | null = null;

  const state = (): LanState => {
    const ip = server ? lanAddress() : null;
    const address = ip && server ? `${ip}:${server.port}` : null;
    const why = error ?? (server && !ip ? "This computer is not on a network right now. Phones reach it once it joins one." : null);
    return { on, address, fingerprint: server ? fingerprint : null, bonjour: bonjour !== null, error: why };
  };

  const close = () => {
    bonjour?.stdin?.end();
    bonjour = null;
    server?.stop(true);
    server = null;
  };

  /** Open the listener (the port it had last time when free) and the record. Throws LanUnavailableError. */
  const open = () => {
    if (server) return;
    const tls = ensureInboxCertificate(context.dataDir);
    const serve = (port: number) =>
      Bun.serve({ hostname: "0.0.0.0", port, idleTimeout: 0, tls: { cert: tls.cert, key: tls.key }, fetch: context.fetch } as Parameters<typeof Bun.serve>[0]);
    const last = context.savedPort();
    try {
      server = last ? serve(last) : serve(0);
    } catch {
      server = serve(0);
    }
    fingerprint = tls.fingerprint;
    bonjour = publishBonjour(context.name(), server.port as number, tls.fingerprint);
  };

  /** At start: the switch was on, so open again. A failure keeps the switch on and says why. */
  const start = () => {
    if (context.savedPort() === null) return;
    on = true;
    try {
      open();
      error = null;
      context.savePort(server!.port as number);
    } catch (cause) {
      close();
      error = cause instanceof Error ? cause.message : String(cause);
    }
  };

  /** A clean stop (quit, the stop route, a restart to update): the listener and the record go; the switch stays on. */
  const stop = () => close();

  /** The window's switch. Throws LanUnavailableError, and the switch stays off. */
  const set = (next: boolean): LanState => {
    if (next) {
      try {
        open();
      } catch (cause) {
        close();
        throw cause;
      }
      on = true;
      error = null;
      context.savePort(server!.port as number);
    } else {
      close();
      on = false;
      error = null;
      context.savePort(null);
    }
    return state();
  };

  return { state, start, stop, set };
}
