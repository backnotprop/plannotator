import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { InboxAccount, InboxMachineAccountsRead, InboxUsageWindow } from '@plannotator/core/inbox-types';
import { HostMark, Icon } from '../icons';
import { accountsFailure, useAccounts, type AccountsFailure, type AccountsView, type MachineAccounts } from '../useAccounts';
import { CodeBox } from './ConnectPicker';

/** The first way claude-swap's README gives. */
const CSWAP_INSTALL_COMMAND = 'uv tool install claude-swap';
/** Saves the account signed in to Claude Code (claude-swap's README). */
const CSWAP_ADD_COMMAND = 'cswap add';
const CSWAP_URL = 'https://github.com/realiti4/claude-swap';

export const FAILURE_TEXT: Record<AccountsFailure, string> = {
  timed_out: 'claude-swap timed out.',
  run_failed: 'claude-swap failed.',
  bad_output: 'claude-swap gave an unreadable answer.',
  unknown_schema: 'Update Plannotator and claude-swap.',
  unreachable: 'The Inbox did not answer.',
};

/** What an account is called: its alias, else the start of its address (the whole address waits in the open row), else it has neither and is an API key. */
function accountLabel(account: InboxAccount): string {
  return account.alias || account.email?.split('@')[0] || 'API key';
}

/** A personal Claude organization is named after the address: it says nothing, and showing it would show the address. */
function accountOrganization(account: InboxAccount): string | null {
  const { organizationName: name, email } = account;
  return name && !(email && name.toLowerCase().includes(email.toLowerCase())) ? name : null;
}

/** A row's name among the others. */
interface RowName {
  label: string;
  /** Only when another row has the same label: one address can be saved under two organizations. */
  organization: string | null;
  /** `cswap`'s number, only when the rows would still read alike. */
  number: number | null;
}

export function rowName(accounts: InboxAccount[], account: InboxAccount): RowName {
  const label = accountLabel(account);
  const organization = accountOrganization(account);
  const namesakes = accounts.filter((other) => accountLabel(other) === label);
  const alike = namesakes.filter((other) => accountOrganization(other) === organization);
  return { label, organization: namesakes.length > 1 ? organization : null, number: alike.length > 1 ? account.number : null };
}

/** Past this, `cswap` could not refresh the reading: its normal serve age is 3 minutes. */
const STALE_AFTER_SECONDS = 600;
export const isStale = (account: InboxAccount) => (account.usageAgeSeconds ?? 0) > STALE_AFTER_SECONDS;

/** Used limits go amber here. */
const HIGH_PCT = 90;
export const shownPct = (window: InboxUsageWindow) => Math.round(window.pct);
export const isHigh = (window: InboxUsageWindow) => shownPct(window) >= HIGH_PCT;

function ageText(seconds: number): string {
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** A limit as a row shows it. `week` holds the right-hand column. */
export interface Meter {
  label: string;
  window: InboxUsageWindow;
  week?: boolean;
}

/** Only the limits reported: 5h, the scoped ones, and week last, so week holds the right-hand column. */
export function accountMeters(account: InboxAccount): Meter[] {
  const { usage } = account;
  if (!usage) return [];
  return [
    ...(usage.fiveHour ? [{ label: '5h', window: usage.fiveHour }] : []),
    ...usage.scoped.map((window) => ({ label: window.name, window })),
    ...(usage.sevenDay ? [{ label: 'week', window: usage.sevenDay, week: true }] : []),
  ];
}

/** One row of the list: a login, the machines it is saved on (none named while no machine is linked), and each one's own copy. */
export interface ListedAccount {
  key: string;
  account: InboxAccount;
  machines: string[];
  copies: { machine: string; account: InboxAccount }[];
}

/** The newer reading of one login on two machines, under the number it came with, and an alias if only one of them gave it. */
function newerReading(held: InboxAccount, other: InboxAccount): InboxAccount {
  const newer = other.usage && (!held.usage || (other.usageAgeSeconds ?? 0) < (held.usageAgeSeconds ?? 0)) ? other : held;
  return { ...newer, number: held.number, alias: held.alias ?? other.alias };
}

/**
 * `cswap`'s number is unique on one machine, so across machines one row may
 * have to give way. The first row to show a number keeps it, so this machine's
 * stay the ones `cswap` prints here; a later one takes a number no row has.
 */
function uniqueNumbers(rows: ListedAccount[]): ListedAccount[] {
  const taken = new Set<number>();
  let spare = Math.max(0, ...rows.map((row) => row.account.number));
  return rows.map((row) => {
    const number = taken.has(row.account.number) ? ++spare : row.account.number;
    taken.add(number);
    return number === row.account.number ? row : { ...row, account: { ...row.account, number } };
  });
}

/**
 * Every machine's accounts as one list, this machine's first: one login saved
 * on two machines is one row, by its address and organization. An API key has
 * no address to tell it by, so it stays its machine's own row, and rows one
 * machine keeps apart stay apart. `seen` holds the page's order: a machine that
 * answers late adds its rows under what is showing, whatever the machines' order.
 */
export function listedAccounts(self: { name: string; accounts: InboxAccount[] }, linked: MachineAccounts[], seen: string[] = []): ListedAccount[] {
  const listed = new Map<string, ListedAccount>();
  const name = (machine: string) => (linked.length > 0 ? [machine] : []);
  const add = (id: string, machine: string, accounts: InboxAccount[]) => {
    const counts = new Map<string, number>();
    for (const account of accounts) {
      const login = account.email ? `${account.email.toLowerCase()}\n${account.organizationName ?? ''}` : `${id}\n${account.number}`;
      const nth = counts.get(login) ?? 0;
      counts.set(login, nth + 1);
      const key = `${login}\n${nth}`;
      const held = listed.get(key);
      const copy = { machine, account };
      if (held) listed.set(key, { key, account: newerReading(held.account, account), machines: [...held.machines, ...name(machine)], copies: [...held.copies, copy] });
      else listed.set(key, { key, account, machines: name(machine), copies: [copy] });
    }
  };
  add('self', self.name, self.accounts);
  for (const { id, name: machine, read } of linked) if (read?.state === 'accounts') add(id, machine, read.accounts);
  for (const key of listed.keys()) if (!seen.includes(key)) seen.push(key);
  return uniqueNumbers([...listed.values()].sort((a, b) => seen.indexOf(a.key) - seen.indexOf(b.key)));
}

/** The states a person has to act on, worst first. A login renewing or a failed fetch passes by itself, and another machine's reading can stand in. */
const NEEDS_A_PERSON = ['relogin_required', 'no_credentials', 'foreign_credential', 'keychain_unavailable'];

/** The worst such state among a login's machines, and which ones. */
function worstState(copies: ListedAccount['copies']): { reason: string; machines: string[] } | null {
  for (const status of NEEDS_A_PERSON) {
    const here = copies.filter(({ account }) => account.usageStatus === status);
    if (here.length > 0) return { reason: noReadingReason(here[0]!.account), machines: here.map(({ machine }) => machine) };
  }
  return null;
}

/** What an open row adds. An organization a row already shows is not said twice. */
function accountMore(account: InboxAccount, meters: Meter[], name: RowName, machines: string[], worst: ReturnType<typeof worstState>): string[] {
  const resets = meters.flatMap(({ label, window }) => {
    const when = window.clock ?? (window.countdown && `in ${window.countdown}`);
    return when ? [`${label} ${when}`] : [];
  });
  const organization = accountOrganization(account);
  const lines: string[] = [];
  if (account.email) lines.push(account.email);
  if (organization && !name.organization) lines.push(organization);
  if (resets.length > 0) lines.push(`Resets ${resets.join(' · ')}`);
  if (meters.length > 0 && isStale(account)) lines.push(`Last read ${ageText(account.usageAgeSeconds!)} ago`);
  if (machines.length > 0) lines.push(machines.join(', '));
  if (worst && machines.length > 1) lines.push(`${worst.reason} on ${worst.machines.join(', ')}`);
  return lines;
}

function usageErrorText(kind: string | null): string {
  if (kind === 'network') return 'Could not reach Anthropic';
  if (kind === 'timeout') return 'Anthropic timed out';
  if (kind === 'http-429') return 'Anthropic rate limit';
  if (kind?.startsWith('http-')) return 'Anthropic refused';
  return 'Usage check failed';
}

/** Why an account has no reading, in plain words (`cswap`'s statuses, json_output.py). */
function noReadingReason(account: InboxAccount): string {
  switch (account.usageStatus) {
    case 'ok':
      return 'No limits reported';
    case 'token_expired':
      return 'Login renewing';
    case 'keychain_unavailable':
      return 'Keychain unreadable';
    case 'relogin_required':
      return 'Sign in again';
    case 'foreign_credential':
      return 'Signed in to another account';
    case 'no_credentials':
      return 'No saved login';
  }
  const reason = usageErrorText(account.usageError);
  const retry = account.usageRetryAt ? new Date(account.usageRetryAt) : null;
  return retry && retry.getTime() > Date.now() ? `${reason}. Try again after ${retry.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : reason;
}

function UsageBar({ meter, lone, stale }: { meter: Meter; lone: boolean; stale: boolean }) {
  const shown = shownPct(meter.window);
  return (
    <span className="ib-acct-bar" data-usage={meter.label} data-high={isHigh(meter.window) && !stale ? '' : undefined} data-week={meter.week ? '' : undefined} data-lone={lone ? '' : undefined}>
      <span className="ib-acct-bar-l">
        <span className="ib-acct-bar-n">{meter.label}</span>
        <b>{shown}%</b>
      </span>
      <i aria-hidden="true" style={{ '--ib-acct-w': `${Math.min(Math.max(shown, 0), 100)}%` } as CSSProperties} />
    </span>
  );
}

/** The right of a row: its bars, or the word for why it has none. An API key already called "API key" needs no second one. */
function AccountUsage({ account, meters }: { account: InboxAccount; meters: Meter[] }) {
  if (account.usageStatus === 'api_key') {
    return account.alias ? (
      <span className="ib-acct-note" data-account-use="api-key">
        API key
      </span>
    ) : null;
  }
  if (meters.length === 0) {
    return (
      <span className="ib-acct-note" data-account-use="none">
        No reading yet
      </span>
    );
  }
  const others = meters.filter((meter) => !meter.week).length;
  const stale = isStale(account);
  return (
    <span className="ib-acct-use" data-account-use="bars" data-windows={meters.length > 2 ? 'many' : undefined} data-stale={stale ? '' : undefined}>
      {meters.map((meter, index) => (
        <UsageBar key={index} meter={meter} lone={!meter.week && others === 1} stale={stale} />
      ))}
    </span>
  );
}

function AccountRow({ row: { account, machines, copies }, name }: { row: ListedAccount; name: RowName }) {
  const [open, setOpen] = useState(false);
  const meters = accountMeters(account);
  const worst = worstState(copies);
  const more = accountMore(account, meters, name, machines, worst);
  const why = worst?.reason ?? (account.usageStatus !== 'api_key' && meters.length === 0 ? noReadingReason(account) : null);
  const head = (
    <>
      <span className="ib-acct-who">
        <span className="ib-acct-l">
          <span className="ib-acct-name">{name.label}</span>
          {name.number !== null && (
            <>
              {' '}
              <span className="ib-acct-num">#{name.number}</span>
            </>
          )}
        </span>
        {name.organization && <span className="ib-acct-org">{name.organization}</span>}
        {why && <span className="ib-acct-why">{why}</span>}
      </span>
      <AccountUsage account={account} meters={meters} />
    </>
  );
  return (
    <li className="ib-acct" data-account={account.number}>
      {more.length > 0 ? (
        <button type="button" className="ib-acct-row" aria-expanded={open} onClick={() => setOpen(!open)}>
          {head}
          <Icon name="chevD" className="ib-acct-car" />
        </button>
      ) : (
        <div className="ib-acct-row">{head}</div>
      )}
      {open && more.length > 0 && (
        <div className="ib-acct-more">
          {more.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}
    </li>
  );
}

function AccountList({ rows, reading, linked }: { rows: ListedAccount[]; reading: boolean; linked: boolean }) {
  if (rows.length === 0) {
    return (
      <div className="ib-card ib-acct-install" data-accounts-none="">
        <span>Sign in to Claude Code, then save the account</span>
        <CodeBox text={CSWAP_ADD_COMMAND} />
      </div>
    );
  }
  const accounts = rows.map((row) => row.account);
  return (
    <ul className="ib-card ib-acct-list" aria-label="Claude Code accounts" aria-busy={reading} data-linked={linked ? '' : undefined}>
      {rows.map((row) => (
        <AccountRow key={row.key} row={row} name={rowName(accounts, row.account)} />
      ))}
    </ul>
  );
}

/** A machine's row says the account it is using, or these few words. A machine without `cswap` says nothing here: Settings → Machines has the rest. */
const NO_ACCOUNT: Record<string, string> = {
  reading: 'Reading accounts…',
  offline: 'Asleep',
  needs_update: 'Update Plannotator',
};

/** A machine's account as the list calls it, once the list has it, so a name and number mean one login on the whole page. */
function listName(rows: ListedAccount[], accounts: InboxAccount[], active: InboxAccount): RowName {
  const row = rows.find(({ copies }) => copies.some((copy) => copy.account === active));
  return row ? rowName(rows.map(({ account }) => account), row.account) : rowName(accounts, active);
}

/** What a machine's row says on its right, in one line, so an answer never moves the rows under it. */
function MachineUse({ read, rows }: { read: AccountsView | InboxMachineAccountsRead | null; rows: ListedAccount[] }) {
  if (read?.state === 'accounts') {
    const active = read.accounts.find((account) => account.active);
    if (active) {
      const { label, organization, number } = listName(rows, read.accounts, active);
      const name = number === null ? label : `${label} #${number}`;
      return (
        <span className="ib-acct-ro" data-machine-use="account">
          <HostMark host="claude-code" />
          <span>{organization ? `${name} · ${organization}` : name}</span>
        </span>
      );
    }
  }
  const failure = read && (read.state === 'failed' || read.state === 'unreachable') ? accountsFailure(read) : null;
  const words = read?.state === 'accounts' ? (read.accounts.length > 0 ? 'No account in use' : 'No accounts yet') : failure ? FAILURE_TEXT[failure] : NO_ACCOUNT[read?.state ?? 'reading'];
  return (
    <span className="ib-acct-ro" data-machine-use={read?.state ?? 'reading'}>
      {words && <span>{words}</span>}
    </span>
  );
}

function MachineRow({ name, read, rows }: { name: string; read: AccountsView | InboxMachineAccountsRead | null; rows: ListedAccount[] }) {
  return (
    <div className="ib-acct-row ib-acct-machine" data-accounts-machine={name}>
      <span className="ib-acct-who">
        <span className="ib-acct-name">{name}</span>
      </span>
      <MachineUse read={read} rows={rows} />
    </div>
  );
}

/** Every machine and the account it is using, this one first. Switch comes here in a later step. */
function MachineGroup({ self, view, linked, rows }: { self: string; view: AccountsView | null; linked: MachineAccounts[]; rows: ListedAccount[] }) {
  return (
    <section className="ib-sgroup ib-sgroup-first" data-accounts-machines="" aria-labelledby="ib-g-machines">
      <div className="ib-acct-h">
        <h2 id="ib-g-machines">
          <Icon name="system" size={15} />
          Machines
        </h2>
      </div>
      <div className="ib-card">
        <MachineRow name={self} read={view} rows={rows} />
        {linked.map((machine) => (
          <MachineRow key={machine.id} name={machine.name} read={machine.read} rows={rows} />
        ))}
      </div>
    </section>
  );
}

/**
 * Settings → Accounts (approval "accounts-page"): the Claude accounts and
 * their usage on this computer and on every linked machine, read-only. A read
 * goes through `cswap` to the Keychain and to Anthropic, so it takes seconds.
 * This page reads when it opens and on Refresh, through the window's one read
 * (useAccounts).
 */
export function AccountsSection({ machine }: { /** This machine's name, when this Inbox knows it. */ machine?: string }) {
  const { view, refreshFailed, reading, machines, read } = useAccounts();
  useEffect(() => {
    void read();
  }, [read]);

  const self = machine ?? 'This machine';
  const own = view?.state === 'accounts' ? view.accounts : [];
  const linked = view?.state === 'owner_only' ? [] : machines;
  // The list waits for this machine's answer, which goes first: nothing is put above rows already showing.
  const seen = useRef<string[]>([]);
  const rows = view === null ? [] : listedAccounts({ name: self, accounts: own }, linked, seen.current);
  const hasMachines = linked.length > 0 || own.some((account) => account.active);
  const failure = refreshFailed ?? (view ? accountsFailure(view) : null);
  return (
    <>
      {hasMachines && <MachineGroup self={self} view={view} linked={linked} rows={rows} />}
      <section className={hasMachines ? 'ib-sgroup' : 'ib-sgroup ib-sgroup-first'} data-settings-accounts={view?.state ?? 'reading'} aria-labelledby="ib-g-claude">
        <div className="ib-acct-h">
          <h2 id="ib-g-claude">
            <HostMark host="claude-code" />
            Claude Code
          </h2>
          {view?.state !== 'owner_only' && (
            <button type="button" className="ib-btn ib-ghost ib-sm" disabled={reading} onClick={() => void read({ fresh: true })} data-accounts-refresh="">
              {reading ? <span className="ib-spin" aria-hidden="true" /> : <Icon name="refresh" size={13} />}
              Refresh
            </button>
          )}
        </div>
        {view === null && (
          <div className="ib-card">
            <div className="ib-acct-wait" role="status" data-accounts-wait="">
              Reading accounts…
            </div>
          </div>
        )}
        {failure && (
          <p role="alert" data-accounts-failed={failure}>
            {FAILURE_TEXT[failure]}
          </p>
        )}
        {(view?.state === 'accounts' || rows.length > 0) && <AccountList rows={rows} reading={reading} linked={linked.length > 0} />}
        {view?.state === 'not_installed' && (
          <div className="ib-card ib-acct-install">
            <span>
              Install{' '}
              <a href={CSWAP_URL} target="_blank" rel="noreferrer">
                claude-swap
              </a>{' '}
              to see usage and switch accounts
            </span>
            <CodeBox text={CSWAP_INSTALL_COMMAND} />
            {/* The Inbox looks only on the PATH it started with, so a Refresh can't find what was installed after that. */}
            <small>Already installed? Restart the Inbox.</small>
          </div>
        )}
        {view?.state === 'owner_only' && <p data-accounts-owner-only="">Owner only.</p>}
      </section>
    </>
  );
}
