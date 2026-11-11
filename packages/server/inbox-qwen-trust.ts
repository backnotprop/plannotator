import { createHash } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { INBOX_QWEN_WAKE_MIN_VERSION } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { qwenHome } from "@plannotator/shared/inbox/qwen-sessions";
import { samePlace, writeAgentFileAtomic } from "./agent-files";
import { agentVersionRun, type AgentEnvironment, type AgentRunResult } from "./inbox-agents";

export const INBOX_QWEN_TRUST_ON_CONNECT = true;

export const INBOX_QWEN_TRUST_MIN_VERSION = INBOX_QWEN_WAKE_MIN_VERSION;

export const INBOX_QWEN_TRUST_FILE = "qwen-trust.json";

const QWEN_CALL_TIMEOUT_MS = 15_000;

const TOKEN = /^qpc_[0-9a-f]{64}$/;
const GRANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const NO_SUCH_GRANT = /no controller has the id/i;

export function qwenTrustLabel(dataDir: string): string {
  let path = resolve(dataDir);
  try {
    path = realpathSync(path);
  } catch {
    // Not made yet: its path as given.
  }
  return `Plannotator Inbox (${createHash("sha256").update(path).digest("hex").slice(0, 8)})`;
}

export interface QwenTrustFile {
  v: 1;
  home: string;
  id?: string;
  token?: string;
  label?: string;
  created_at?: string;
  revoked_outside_at?: string;
  revoked_said?: boolean;
  failed?: string;
  revoke_pending?: true;
}

export function qwenTrustPath(dataDir: string): string {
  return join(inboxDir(dataDir), INBOX_QWEN_TRUST_FILE);
}

export function readQwenTrust(dataDir: string): QwenTrustFile | null {
  try {
    const parsed = JSON.parse(readFileSync(qwenTrustPath(dataDir), "utf8")) as Partial<QwenTrustFile>;
    if (!parsed || parsed.v !== 1 || typeof parsed.home !== "string" || !parsed.home) return null;
    const id = typeof parsed.id === "string" && GRANT_ID.test(parsed.id);
    const pending = id && parsed.revoke_pending === true;
    // A grant waiting to be revoked has its id only: its token is never read back, so never presented.
    const grant = id && !pending && typeof parsed.token === "string" && TOKEN.test(parsed.token);
    return {
      v: 1,
      home: parsed.home,
      ...(grant ? { id: parsed.id, token: parsed.token } : {}),
      ...(pending ? { id: parsed.id, revoke_pending: true as const } : {}),
      ...(typeof parsed.label === "string" ? { label: parsed.label } : {}),
      ...(typeof parsed.created_at === "string" ? { created_at: parsed.created_at } : {}),
      ...(typeof parsed.revoked_outside_at === "string" ? { revoked_outside_at: parsed.revoked_outside_at } : {}),
      ...(parsed.revoked_said === true ? { revoked_said: true } : {}),
      ...(typeof parsed.failed === "string" ? { failed: parsed.failed } : {}),
    };
  } catch {
    return null;
  }
}

function writeQwenTrust(dataDir: string, file: QwenTrustFile): void {
  writeAgentFileAtomic(qwenTrustPath(dataDir), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

export function qwenTrustHome(e: Pick<AgentEnvironment, "env" | "homeDir">): string {
  return qwenHome(e.env, e.homeDir, e.homeDir);
}

export function qwenWakeToken(dataDir: string, home: string): string | null {
  const file = readQwenTrust(dataDir);
  return file?.token && samePlace(file.home, home) ? file.token : null;
}

export function parseQwenVersion(text: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/m.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function qwenHasTrust(version: readonly [number, number, number] | null): boolean {
  if (!version) return false;
  const min = INBOX_QWEN_TRUST_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (version[i]! !== min[i]!) return version[i]! > min[i]!;
  return true;
}

export type QwenTrustOutcome =
  | { kind: "added" }
  /** There already, and Qwen still lists it. */
  | { kind: "kept" }
  /** No `qwen` on PATH, one older than 0.24, or Windows: no token, no wake. */
  | { kind: "none"; why: string }
  /** The person revoked it in Qwen; not minted again by itself. `first`: not said before. */
  | { kind: "revoked_outside"; first?: boolean }
  /** `repeated`: the same reason as the last run's, so the terminal does not say it again. */
  | { kind: "failed"; reason: string; repeated?: boolean };

export type QwenRevokeResult =
  | { kind: "revoked" }
  /** `qwen` could not run: the token is forgotten here, and the grant may still be in Qwen (`manual` removes it). */
  | { kind: "forgotten"; manual: string }
  /** Qwen would not revoke it: the token is forgotten (never presented again), the id kept so the next connect run tries again; `manual` revokes it by hand. */
  | { kind: "failed"; reason: string; manual: string; held?: boolean };

export const QWEN_TRUST_REVOKED_REASON =
  "Plannotator's trusted-sender grant was removed in Qwen Code, so your replies wait until it reads the Inbox; turn Qwen Code off and on in Settings → Agents to trust Plannotator again";

function said(text: string): string {
  return text.trim().split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 200) ?? "";
}

function runQwen(e: AgentEnvironment, bin: string, args: string[], home: string, signal?: AbortSignal): Promise<AgentRunResult> {
  return e.run([bin, ...args], { timeoutMs: QWEN_CALL_TIMEOUT_MS, cwd: e.homeDir, env: { QWEN_HOME: home }, ...(signal ? { signal } : {}) });
}

async function listGrants(bin: string, e: AgentEnvironment, home: string, signal?: AbortSignal): Promise<{ id: string; label: string }[] | null> {
  const run = await runQwen(e, bin, ["sessions", "controllers", "list", "--json"], home, signal);
  if (run.timedOut || run.exitCode !== 0) return null;
  const grants: { id: string; label: string }[] = [];
  for (const line of run.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { id?: unknown; label?: unknown } | null;
      // Any other shape (an array, a message line): this Qwen answers otherwise, so the list is unknown, never empty.
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || typeof value.label !== "string") return null;
      grants.push({ id: value.id, label: value.label });
    } catch {
      return null;
    }
  }
  return grants;
}

async function revokeGrant(bin: string, e: AgentEnvironment, home: string, id: string, signal?: AbortSignal): Promise<{ gone: true } | { gone: false; reason: string }> {
  const run = await runQwen(e, bin, ["sessions", "controllers", "remove", id], home, signal);
  const command = `qwen sessions controllers remove ${id}`;
  if (run.timedOut) return { gone: false, reason: `${command} did not finish` };
  if (run.exitCode === 0 || NO_SUCH_GRANT.test(`${run.stderr}\n${run.stdout}`)) return { gone: true };
  return { gone: false, reason: `${command} exited with code ${run.exitCode}${said(run.stderr) ? ` (${said(run.stderr)})` : ""}` };
}

async function qwenVersion(e: AgentEnvironment, bin: string, signal?: AbortSignal): Promise<{ version: [number, number, number] | null } | { failed: string }> {
  const run = await agentVersionRun(e, bin, { timeoutMs: QWEN_CALL_TIMEOUT_MS, cwd: e.homeDir, ...(signal ? { signal } : {}) });
  if (run.timedOut) return { failed: "qwen --version did not finish" };
  return { version: run.exitCode === 0 ? parseQwenVersion(run.stdout) : null };
}

export async function ensureQwenTrust(dataDir: string, e: AgentEnvironment, options: { force?: boolean; signal?: AbortSignal; now?: () => Date } = {}): Promise<QwenTrustOutcome> {
  if (e.platform === "win32") return { kind: "none", why: "Qwen Code sessions on Windows can't be woken" };
  const at = (options.now ?? (() => new Date()))().toISOString();
  const home = qwenTrustHome(e);
  const label = qwenTrustLabel(dataDir);
  const bin = e.which("qwen");
  if (!bin) return { kind: "none", why: "qwen is not on PATH" };
  const { signal } = options;
  let file = readQwenTrust(dataDir);
  const earlier = file?.failed;
  const fail = (reason: string): QwenTrustOutcome => {
    try {
      writeQwenTrust(dataDir, { ...(file?.id ? file : { v: 1 as const, home }), failed: reason });
    } catch {
      // Said again next time.
    }
    return { kind: "failed", reason, ...(earlier === reason ? { repeated: true } : {}) };
  };

  // One Qwen home however it is spelled (a symlink, a trailing slash, another case on macOS): never moved to itself.
  const here = (other: string) => samePlace(other, home);
  if (file?.revoked_outside_at && here(file.home) && !options.force) {
    if (file.revoked_said) return { kind: "revoked_outside" };
    try {
      writeQwenTrust(dataDir, { ...file, revoked_said: true });
    } catch {
      // Said again next time.
    }
    return { kind: "revoked_outside", first: true };
  }

  const probe = await qwenVersion(e, bin, signal);
  if ("failed" in probe) return { kind: "failed", reason: probe.failed };
  if (!qwenHasTrust(probe.version)) {
    return { kind: "none", why: probe.version ? `Qwen Code ${probe.version.join(".")} has no trusted senders (0.24 or later has)` : "this qwen did not answer like Qwen Code" };
  }

  if (file?.id && file.revoke_pending) {
    const revoked = await revokeGrant(bin, e, file.home, file.id, signal);
    if (!revoked.gone) return fail(`Plannotator's earlier trusted-sender grant could not be removed (${revoked.reason})`);
    rmSync(qwenTrustPath(dataDir), { force: true });
    file = null;
  }
  if (file?.id && file.token && !here(file.home)) {
    const moved = await revokeGrant(bin, e, file.home, file.id, signal);
    if (!moved.gone) return fail(`Plannotator's trusted-sender grant in ${file.home} could not be removed (${moved.reason})`);
    rmSync(qwenTrustPath(dataDir), { force: true });
    file = null;
  }
  if (file && !here(file.home)) file = null;

  const grants = await listGrants(bin, e, home, signal);
  if (file?.id && file.token) {
    // Unreadable list: the token is kept as it is.
    if (grants === null || grants.some((grant) => grant.id === file!.id)) {
      if (file.failed) writeQwenTrust(dataDir, { ...file, failed: undefined });
      return { kind: "kept" };
    }
    writeQwenTrust(dataDir, { v: 1, home, label, revoked_outside_at: at, ...(options.force ? {} : { revoked_said: true }) });
    if (!options.force) return { kind: "revoked_outside", first: true };
    file = null;
  }
  for (const grant of grants ?? []) {
    if (grant.label !== label || !GRANT_ID.test(grant.id)) continue;
    await revokeGrant(bin, e, home, grant.id, signal);
  }

  const add = await runQwen(e, bin, ["sessions", "controllers", "add", "--label", label, "--json"], home, signal);
  if (add.timedOut) return fail("qwen sessions controllers add did not finish");
  if (add.exitCode !== 0) return fail(`qwen sessions controllers add exited with code ${add.exitCode}${said(add.stderr) ? ` (${said(add.stderr)})` : ""}`);
  let grant: { id?: unknown; token?: unknown } | null = null;
  for (const line of add.stdout.split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object") {
        grant = value as { id?: unknown; token?: unknown };
        break;
      }
    } catch {
      // Not the JSON line.
    }
  }
  if (!grant || typeof grant.id !== "string" || !GRANT_ID.test(grant.id) || typeof grant.token !== "string" || !TOKEN.test(grant.token)) {
    return fail("qwen sessions controllers add did not answer with a token");
  }
  try {
    writeQwenTrust(dataDir, { v: 1, home, id: grant.id, token: grant.token, label, created_at: at });
  } catch (error) {
    // Never leave a grant in Qwen that nothing holds.
    await revokeGrant(bin, e, home, grant.id, signal);
    return { kind: "failed", reason: `the token could not be kept (${error instanceof Error ? error.message : String(error)})` };
  }
  return { kind: "added" };
}

export async function checkQwenTrust(dataDir: string, e: AgentEnvironment, now: () => Date = () => new Date()): Promise<"listed" | "gone" | "unknown"> {
  if (e.platform === "win32") return "unknown";
  const file = readQwenTrust(dataDir);
  const bin = e.which("qwen");
  if (!file?.id || !file.token || !bin) return "unknown";
  const grants = await listGrants(bin, e, file.home);
  if (grants === null) return "unknown";
  if (grants.some((grant) => grant.id === file.id)) return "listed";
  const current = readQwenTrust(dataDir);
  if (current?.id !== file.id) return "unknown";
  writeQwenTrust(dataDir, { v: 1, home: file.home, ...(file.label ? { label: file.label } : {}), revoked_outside_at: now().toISOString() });
  return "gone";
}

export async function retryQwenRevoke(dataDir: string, e: AgentEnvironment, signal?: AbortSignal): Promise<{ kind: "revoked" } | { kind: "failed"; reason: string; repeated: boolean } | null> {
  const file = readQwenTrust(dataDir);
  if (!file?.id || !file.revoke_pending) return null;
  const bin = e.which("qwen");
  if (!bin) return null;
  const revoked = await revokeGrant(bin, e, file.home, file.id, signal);
  if (revoked.gone) {
    rmSync(qwenTrustPath(dataDir), { force: true });
    return { kind: "revoked" };
  }
  const reason = `Plannotator's trusted-sender grant in Qwen Code could not be removed (${revoked.reason}); it is no longer used, and Plannotator tries again at the next start, or run \`${revokeCommand(file, e)}\``;
  try {
    writeQwenTrust(dataDir, { ...file, failed: reason });
  } catch {
    // Said again next time.
  }
  return { kind: "failed", reason, repeated: file.failed === reason };
}

const UNWRITABLE = "Plannotator's data folder can't be written, so the token could not be removed from it";

function revokeCommand(file: QwenTrustFile, e: AgentEnvironment): string {
  const command = `qwen sessions controllers remove ${file.id}`;
  return samePlace(file.home, qwenTrustHome(e)) ? command : `QWEN_HOME=${file.home} ${command}`;
}

export function qwenTrustRemoval(dataDir: string, e: AgentEnvironment): { describe: string; manual: string; runnable: boolean; apply: () => Promise<QwenRevokeResult> } | null {
  const file = readQwenTrust(dataDir);
  if (!file?.id) return null;
  const id = file.id;
  const manual = revokeCommand(file, e);
  const describe = `Plannotator's trusted-sender token in Qwen Code (${manual})`;
  const bin = e.which("qwen");
  return {
    describe,
    manual,
    runnable: bin !== null,
    apply: async () => {
      // Never throws: uninstall goes on to the entries and the binary whatever happens here.
      const path = qwenTrustPath(dataDir);
      const remove = (): boolean => {
        try {
          rmSync(path, { force: true });
          return true;
        } catch {
          return false;
        }
      };
      // Without qwen nothing can revoke it: the token is forgotten, so nothing here presents it again.
      if (!bin) return remove() ? { kind: "forgotten", manual } : { kind: "failed", reason: `qwen is not on PATH, and ${UNWRITABLE}`, manual, held: true };
      // The token goes before Qwen is asked, so whatever happens next nothing presents it again; the id stays for the next retry.
      let kept = true;
      try {
        writeQwenTrust(dataDir, { v: 1, home: file.home, id, ...(file.label ? { label: file.label } : {}), revoke_pending: true });
      } catch {
        kept = false;
        if (!remove()) return { kind: "failed", reason: UNWRITABLE, manual, held: true };
      }
      const revoked = await revokeGrant(bin, e, file.home, id).catch((error: unknown) => ({ gone: false as const, reason: error instanceof Error ? error.message : String(error) }));
      if (revoked.gone) {
        remove();
        return { kind: "revoked" };
      }
      // Qwen would not revoke it: the token is gone already, the id kept for the next try (unless the data folder can't be written).
      return { kind: "failed", reason: kept ? revoked.reason : `${revoked.reason}; the grant id could not be kept to try again`, manual };
    },
  };
}

export async function setQwenTrust(on: boolean, dataDir: string, e: AgentEnvironment): Promise<string | null> {
  if (on) {
    const outcome = await ensureQwenTrust(dataDir, e, { force: true });
    return outcome.kind === "failed" ? `Qwen Code won't get your replies by itself: ${outcome.reason}` : null;
  }
  const removal = qwenTrustRemoval(dataDir, e);
  if (!removal) {
    rmSync(qwenTrustPath(dataDir), { force: true });
    return null;
  }
  const result = await removal.apply();
  if (result.kind === "revoked") return null;
  if (result.kind === "forgotten") return `qwen is not on PATH, so Plannotator's trusted-sender grant may still be in Qwen Code; run \`${result.manual}\` to remove it`;
  if (result.held) return `Plannotator's trusted-sender grant in Qwen Code could not be removed (${result.reason}); run \`${result.manual}\``;
  return `Plannotator's trusted-sender grant in Qwen Code could not be removed (${result.reason}). Plannotator no longer uses it and tries again at the next start, or run \`${result.manual}\``;
}
