import { useEffect, useState, type CSSProperties } from 'react';
import type { InboxAccount, InboxUsageWindow } from '@plannotator/core/inbox-types';
import { HostMark, Icon } from '../icons';
import { accountsFailure, useAccounts, type AccountsFailure } from '../useAccounts';
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

/** What an open row adds. An organization a row already shows is not said twice. */
function accountMore(account: InboxAccount, meters: Meter[], name: RowName): string[] {
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

function AccountRow({ account, name }: { account: InboxAccount; name: RowName }) {
  const [open, setOpen] = useState(false);
  const meters = accountMeters(account);
  const more = accountMore(account, meters, name);
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
        {account.usageStatus !== 'api_key' && meters.length === 0 && <span className="ib-acct-why">{noReadingReason(account)}</span>}
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

function AccountList({ accounts, reading }: { accounts: InboxAccount[]; reading: boolean }) {
  if (accounts.length === 0) {
    return (
      <div className="ib-card ib-acct-install" data-accounts-none="">
        <span>Sign in to Claude Code, then save the account</span>
        <CodeBox text={CSWAP_ADD_COMMAND} />
      </div>
    );
  }
  return (
    <ul className="ib-card ib-acct-list" aria-label="Claude Code accounts" aria-busy={reading}>
      {accounts.map((account) => (
        <AccountRow key={account.number} account={account} name={rowName(accounts, account)} />
      ))}
    </ul>
  );
}

/** This machine and the account it is using. Its Switch comes here in a later step. */
function MachineGroup({ machine, active, accounts }: { machine: string; active: InboxAccount; accounts: InboxAccount[] }) {
  const { label, organization, number } = rowName(accounts, active);
  const name = number === null ? label : `${label} #${number}`;
  return (
    <section className="ib-sgroup ib-sgroup-first" data-accounts-machine="" aria-labelledby="ib-g-machines">
      <div className="ib-acct-h">
        <h2 id="ib-g-machines">
          <Icon name="system" size={15} />
          Machines
        </h2>
      </div>
      <div className="ib-card">
        <div className="ib-acct-row">
          <span className="ib-acct-who">
            <span className="ib-acct-name">{machine}</span>
          </span>
          <span className="ib-acct-ro">
            <HostMark host="claude-code" />
            <span>{organization ? `${name} · ${organization}` : name}</span>
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * Settings → Accounts (approval "accounts-page", step 1): this computer's
 * Claude accounts and their usage, read-only. A read goes through `cswap` to
 * the Keychain and to Anthropic, so it takes seconds. This page reads when it
 * opens and on Refresh, through the window's one read (useAccounts).
 */
export function AccountsSection({ machine }: { /** This machine's name, when this Inbox knows it. */ machine?: string }) {
  const { view, refreshFailed, reading, read } = useAccounts();
  useEffect(() => {
    void read();
  }, [read]);

  const active = view?.state === 'accounts' ? view.accounts.find((account) => account.active) : undefined;
  const failure = refreshFailed ?? (view ? accountsFailure(view) : null);
  return (
    <>
      {active && view?.state === 'accounts' && <MachineGroup machine={machine ?? 'This machine'} active={active} accounts={view.accounts} />}
      <section className={active ? 'ib-sgroup' : 'ib-sgroup ib-sgroup-first'} data-settings-accounts={view?.state ?? 'reading'} aria-labelledby="ib-g-claude">
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
        {view?.state === 'accounts' && <AccountList accounts={view.accounts} reading={reading} />}
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
