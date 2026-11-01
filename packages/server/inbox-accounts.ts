/**
 * Settings → Accounts (approval "accounts-page", step 1): this computer's
 * Claude accounts and their usage, read through claude-swap (`cswap`, which
 * the person installs). Plannotator never reads, stores or moves credentials.
 *
 * `cswap list --json` reads the Keychain and fetches usage from Anthropic, so
 * it is a read that takes seconds and whose output sits next to secrets:
 *
 *  - Named fields only: every value below is picked by name, so a field a later
 *    `cswap` adds cannot reach the window.
 *  - Its output, stderr and error text are never logged, stored or passed on.
 *    A failure is a fixed reason code.
 *  - One read at a time, shared by whoever asks while it runs. Nothing polls:
 *    a read happens when the page opens or on Refresh.
 */

import type { InboxAccount, InboxAccountsFailure, InboxAccountsRead, InboxAccountUsage, InboxUsageWindow } from "@plannotator/core/inbox-types";
import { runWithTimeout, type AgentEnvironment } from "./inbox-agents";

/** The `schemaVersion` of `cswap list --json` this build reads. Extra fields are fine; another version is not. */
const CSWAP_SCHEMA_VERSION = 1;
/** The Keychain and Anthropic's usage endpoint are behind this read. */
export const INBOX_ACCOUNTS_TIMEOUT_MS = 20_000;
/** The address `cswap` gives an API-key account (`api-key-3@token.local`). */
const PLACEHOLDER_EMAIL = /@token\.local$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
/** A status or error kind (`api_key`, `http-429`): a word, or nothing, so a sentence of `cswap`'s never travels in it. */
const word = (value: unknown): string | null => (typeof value === "string" && /^[\w-]{1,40}$/.test(value) ? value : null);

function usageWindow(value: unknown): InboxUsageWindow | null {
  if (!isRecord(value) || typeof value.pct !== "number" || !Number.isFinite(value.pct)) return null;
  return { pct: value.pct, resetsAt: text(value.resetsAt), countdown: text(value.countdown), clock: text(value.clock) };
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
  };
}

const failed = (reason: InboxAccountsFailure): InboxAccountsRead => ({ state: "failed", reason });

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
  const accounts = output.accounts.map(account);
  if (accounts.some((row) => row === null)) return failed("bad_output");
  return { state: "accounts", accounts: accounts as InboxAccount[] };
}

export interface InboxAccountsOptions {
  environment: AgentEnvironment;
  /** Default `INBOX_ACCOUNTS_TIMEOUT_MS`; tests give a short one. */
  timeoutMs?: number;
  /** The Inbox stopping ends a read still going. */
  signal?: AbortSignal;
}

export function createInboxAccounts({ environment, timeoutMs = INBOX_ACCOUNTS_TIMEOUT_MS, signal }: InboxAccountsOptions) {
  const readOnce = async (): Promise<InboxAccountsRead> => {
    const cswap = environment.which("cswap");
    if (!cswap) return { state: "not_installed" };
    const run = await runWithTimeout([cswap, "list", "--json"], environment.env, timeoutMs, signal);
    if (run.timedOut) return failed("timed_out");
    if (run.exitCode !== 0) return failed("run_failed");
    return parseCswapList(run.stdout);
  };
  let reading: Promise<InboxAccountsRead> | null = null;
  return {
    read(): Promise<InboxAccountsRead> {
      reading ??= readOnce().finally(() => {
        reading = null;
      });
      return reading;
    },
  };
}
