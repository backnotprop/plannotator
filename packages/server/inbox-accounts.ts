/**
 * Settings → Accounts (approval "accounts-page", step 1): this computer's
 * Claude accounts and their usage, read through claude-swap (`cswap`, which
 * the person installs). Plannotator never reads, stores or moves credentials.
 *
 * `cswap list --json` reads the Keychain and fetches usage from Anthropic. To
 * fetch usage it may refresh an expired login: it spends the old one-time
 * token and writes the new one back, all inside claude-swap, as typing
 * `cswap list` does. The Inbox itself touches no credential, but killing that
 * run between the spend and the write would lose the login, so:
 *
 *  - A run is never killed for being slow, and the Inbox stopping leaves it to
 *    finish. A person waits `INBOX_ACCOUNTS_TIMEOUT_MS`; only a run still going
 *    at `INBOX_ACCOUNTS_HARD_LIMIT_MS` is killed, as truly stuck.
 *  - One run at a time in this Inbox, until it has really ended. Whoever asks
 *    while it runs joins it, even after an earlier caller was told it timed
 *    out. A run a stopped Inbox left behind can overlap the next Inbox's:
 *    `cswap` holds its own locks for that. Nothing polls: a run starts when a
 *    window, the page or the Usage peek opens, or on Refresh.
 *  - At most one process per `INBOX_ACCOUNTS_CACHE_MS` in this Inbox, whoever
 *    asks and however: an answer serves that long, a failure as well as a good
 *    one, so a broken `cswap` runs once however often a window opens. Refresh
 *    (`fresh`, from a window here or a machine linked here) reads again only
 *    once that time has passed since the last run started, and otherwise gets
 *    the last reading. `cswap` refreshes a login at most once per its own 3
 *    minutes however often it runs: this saves processes, not logins.
 *  - `cswap` gone shows at once: finding that out starts no process.
 *
 * Its output sits next to secrets:
 *
 *  - Named fields only: every value below is picked by name, so a field a later
 *    `cswap` adds cannot reach the window.
 *  - Its output and error text are never logged, stored or passed on. A
 *    failure is a fixed reason code.
 *
 * A linked machine's read is this same read on that machine, asked for through
 * its door (`accountsOf` in inbox-machines.ts) and picked by name again here.
 */

import type { InboxAccount, InboxAccountsFailure, InboxAccountsRead, InboxAccountUsage, InboxMachineAccountsRead, InboxUsageWindow } from "@plannotator/core/inbox-types";
import { createAgentEnvironmentFor, runUntilExit, type AgentEnvironment } from "./inbox-agents";

/** The `schemaVersion` of `cswap list --json` this build reads. Extra fields are fine; another version is not. */
const CSWAP_SCHEMA_VERSION = 1;
/** How long a person waits. The Keychain and Anthropic's usage endpoint are behind this read. The run goes on. */
export const INBOX_ACCOUNTS_TIMEOUT_MS = 20_000;
/** How long this Inbox waits for a linked machine: past its limit above, so a slow run comes back as its own `timed_out`. */
export const INBOX_MACHINE_ACCOUNTS_WAIT_MS = INBOX_ACCOUNTS_TIMEOUT_MS + 5_000;
/** Last resort for a run that is truly stuck; a slow login refresh ends long before this. */
export const INBOX_ACCOUNTS_HARD_LIMIT_MS = 120_000;
/** How long a run's answer serves, a failure's too, and so the least time between two runs. */
export const INBOX_ACCOUNTS_CACHE_MS = 30_000;
/** The most of a linked machine's answer this Inbox reads: 16 times what a run may print (the 64 KiB cap in inbox-agents.ts). */
export const INBOX_MACHINE_ACCOUNTS_MAX_BYTES = 1024 * 1024;
/** No person has this many logins: the rest of a far answer's list is dropped, so it can't slow a window that draws every row. */
const MACHINE_ACCOUNTS_MAX_ROWS = 200;
/** No address, alias or name is this long: past it a field is dropped, so a far answer can't fill a window with one. */
const TEXT_MAX = 1_024;
/** The address `cswap` gives an API-key account (`api-key-3@token.local`). */
const PLACEHOLDER_EMAIL = /@token\.local$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" && value.length <= TEXT_MAX ? value : null);
/** A status or error kind (`api_key`, `http-429`): a word, or nothing, so a sentence of `cswap`'s never travels in it. */
const word = (value: unknown): string | null => (typeof value === "string" && /^[\w-]{1,40}$/.test(value) ? value : null);

/** A reset time gone by: `cswap` serves its last good reading when a fetch fails, so the figure is from before that reset. */
function hasPassed(resetsAt: string | null): boolean {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return Number.isFinite(at) && at <= Date.now();
}

function usageWindow(value: unknown): InboxUsageWindow | null {
  if (!isRecord(value) || typeof value.pct !== "number" || !Number.isFinite(value.pct)) return null;
  const resetsAt = text(value.resetsAt);
  if (hasPassed(resetsAt)) return null;
  return { pct: value.pct, resetsAt, countdown: text(value.countdown), clock: text(value.clock) };
}

function accountUsage(value: unknown): InboxAccountUsage | null {
  if (!isRecord(value)) return null;
  const fiveHour = usageWindow(value.fiveHour);
  const sevenDay = usageWindow(value.sevenDay);
  const scoped = (Array.isArray(value.scoped) ? value.scoped : []).flatMap((item) => {
    const window = usageWindow(item);
    const name = isRecord(item) ? text(item.name) : null;
    return window && name ? [{ ...window, name }] : [];
  });
  return fiveHour || sevenDay || scoped.length > 0 ? { fiveHour, sevenDay, scoped } : null;
}

function account(row: unknown): InboxAccount | null {
  if (!isRecord(row) || !Number.isInteger(row.number)) return null;
  const usageStatus = word(row.usageStatus);
  const email = text(row.email);
  return {
    number: row.number as number,
    alias: text(row.alias),
    email: usageStatus === "api_key" || (email && PLACEHOLDER_EMAIL.test(email)) ? null : email,
    organizationName: text(row.organizationName),
    isOrganization: row.isOrganization === true,
    active: row.active === true,
    usageStatus,
    usageError: word(row.usageError),
    usageRetryAt: text(row.usageRetryAt),
    usage: accountUsage(row.usage),
    usageAgeSeconds: typeof row.usageAgeSeconds === "number" && Number.isFinite(row.usageAgeSeconds) && row.usageAgeSeconds >= 0 ? row.usageAgeSeconds : null,
  };
}

const FAILURES: readonly string[] = ["timed_out", "run_failed", "bad_output", "unknown_schema"] satisfies InboxAccountsFailure[];
const failed = (reason: InboxAccountsFailure): InboxAccountsRead => ({ state: "failed", reason });

function accountList(rows: unknown[]): InboxAccount[] | null {
  const accounts = rows.map(account);
  return accounts.some((row) => row === null) ? null : (accounts as InboxAccount[]);
}

/**
 * What a linked machine's door answered, picked by name here too: its Inbox
 * may be older, newer or hostile, so nothing it adds reaches this window, and
 * its failure stays a fixed code. An object this build can't read comes from a
 * version apart; anything else is no answer to this read.
 */
export function parsePeerAccounts(value: unknown): InboxMachineAccountsRead {
  if (!isRecord(value)) return { state: "unreachable" };
  if (value.state === "not_installed") return { state: "not_installed" };
  if (value.state === "failed") return failed(typeof value.reason === "string" && FAILURES.includes(value.reason) ? (value.reason as InboxAccountsFailure) : "run_failed");
  const accounts = value.state === "accounts" && Array.isArray(value.accounts) ? accountList(value.accounts.slice(0, MACHINE_ACCOUNTS_MAX_ROWS)) : null;
  return accounts ? { state: "accounts", accounts } : { state: "needs_update" };
}

/** What the window may know of `cswap list --json`'s output. */
export function parseCswapList(stdout: string): InboxAccountsRead {
  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    return failed("bad_output");
  }
  if (!isRecord(output) || typeof output.schemaVersion !== "number") return failed("bad_output");
  if (output.schemaVersion !== CSWAP_SCHEMA_VERSION) return failed("unknown_schema");
  if (!Array.isArray(output.accounts)) return failed("bad_output");
  const accounts = accountList(output.accounts);
  return accounts ? { state: "accounts", accounts } : failed("bad_output");
}

export interface InboxAccountsOptions {
  environment: AgentEnvironment;
  /** Default `INBOX_ACCOUNTS_TIMEOUT_MS`; tests give a short one. */
  timeoutMs?: number;
  /** Default `INBOX_ACCOUNTS_HARD_LIMIT_MS`; tests give a short one. */
  hardLimitMs?: number;
  /** Default `INBOX_ACCOUNTS_CACHE_MS`; 0 for a test that changes the answer between reads. */
  cacheMs?: number;
}

/**
 * What a spec may set on a compiled binary, heard only in a sandbox (loopback
 * links need one, and it empties the agent PATH): the folder of a fake `cswap`,
 * and the time an answer serves, for a spec that changes it between reads.
 */
export function accountsTestOptions(env: Record<string, string | undefined>): { cswapDir?: string; cacheMs?: number } {
  if (!env.PLANNOTATOR_TEST_SANDBOX) return {};
  const cache = env.PLANNOTATOR_TEST_ACCOUNTS_CACHE_MS;
  return { ...(env.PLANNOTATOR_TEST_CSWAP_DIR ? { cswapDir: env.PLANNOTATOR_TEST_CSWAP_DIR } : {}), ...(cache ? { cacheMs: Number(cache) } : {}) };
}

/** This Inbox's read: `environment`'s `cswap`, unless a spec in a sandbox named another (`accountsTestOptions`). */
export function createInboxAccountsFor(environment: AgentEnvironment, options: Partial<InboxAccountsOptions> = {}, env: Record<string, string | undefined> = process.env) {
  const { cswapDir, ...forSpec } = accountsTestOptions(env);
  const { homeDir } = environment;
  return createInboxAccounts({
    environment: cswapDir ? createAgentEnvironmentFor({ platform: process.platform, homeDir, env: { HOME: homeDir, PATH: cswapDir } }) : environment,
    ...forSpec,
    ...options,
  });
}

export function createInboxAccounts({ environment, timeoutMs = INBOX_ACCOUNTS_TIMEOUT_MS, hardLimitMs = INBOX_ACCOUNTS_HARD_LIMIT_MS, cacheMs = INBOX_ACCOUNTS_CACHE_MS }: InboxAccountsOptions) {
  const runOnce = async (cswap: string): Promise<InboxAccountsRead> => {
    const run = await runUntilExit([cswap, "list", "--json"], environment.env, hardLimitMs);
    if (run.timedOut) return failed("timed_out");
    // The shell's "command not found": a shim whose tool is gone, which is not installed. The e2e stubs exit this way too.
    if (run.exitCode === 127) return { state: "not_installed" };
    if (run.exitCode !== 0) return failed("run_failed");
    return parseCswapList(run.stdout);
  };
  /** The run going now, until it has really ended. */
  let running: Promise<InboxAccountsRead> | null = null;
  let startedAt = Number.NEGATIVE_INFINITY;
  let last: { at: number; answer: InboxAccountsRead } | null = null;
  return {
    /** Whether `cswap` is on this PATH. Looks only: runs nothing. */
    installed: (): boolean => environment.which("cswap") !== null,
    read({ fresh = false }: { fresh?: boolean } = {}): Promise<InboxAccountsRead> {
      const cswap = environment.which("cswap");
      if (!cswap) {
        last = null;
        return Promise.resolve({ state: "not_installed" });
      }
      const now = Date.now();
      // A time ahead of now is a clock set back: not a reason to wait for it to catch up.
      const recent = (at: number) => now >= at && now - at < cacheMs;
      if (last && recent(last.at) && (!fresh || recent(startedAt))) return Promise.resolve(last.answer);
      if (!running) {
        startedAt = now;
        running = runOnce(cswap)
          .then((answer) => {
            last = { at: Date.now(), answer };
            return answer;
          })
          .finally(() => {
            running = null;
          });
      }
      // Each caller waits its own limit, so a Refresh during a slow run can still get that run's answer.
      let limit: ReturnType<typeof setTimeout>;
      const tooLong = new Promise<InboxAccountsRead>((done) => {
        limit = setTimeout(() => done(failed("timed_out")), timeoutMs);
      });
      return Promise.race([running, tooLong]).finally(() => clearTimeout(limit));
    },
  };
}
