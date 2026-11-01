import { useEffect, useState, type CSSProperties } from 'react';
import type { InboxAccount, InboxAccountsFailure, InboxAccountsRead, InboxUsageWindow } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi } from '../api';
import { HostMark, Icon } from '../icons';
import { CodeBox } from './ConnectPicker';

/** The first way claude-swap's README gives. */
const CSWAP_INSTALL_COMMAND = 'uv tool install claude-swap';
/** Saves the account signed in to Claude Code (claude-swap's README). */
const CSWAP_ADD_COMMAND = 'cswap add';
const CSWAP_URL = 'https://github.com/realiti4/claude-swap';

/** The read's answer, or why there is none: a tailnet guest, or an Inbox that did not answer. */
type View = InboxAccountsRead | { state: 'owner_only' } | { state: 'unreachable' };

const FAILURE_TEXT: Record<InboxAccountsFailure | 'unreachable', string> = {
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

/** One address can be saved under two organizations: only then does a name need its organization. */
function sharesName(accounts: InboxAccount[], account: InboxAccount): boolean {
  return accounts.filter((other) => accountLabel(other) === accountLabel(account)).length > 1;
}

/** A limit as a row shows it. `week` holds the right-hand column. */
interface Meter {
  label: string;
  window: InboxUsageWindow;
  week?: boolean;
}

/** Only the limits reported: 5h, the scoped ones, and week last, so week holds the right-hand column. */
function accountMeters(account: InboxAccount): Meter[] {
  const { usage } = account;
  if (!usage) return [];
  return [
    ...(usage.fiveHour ? [{ label: '5h', window: usage.fiveHour }] : []),
    ...usage.scoped.map((window) => ({ label: window.name, window })),
    ...(usage.sevenDay ? [{ label: 'week', window: usage.sevenDay, week: true }] : []),
  ];
}

/** What an open row adds. An organization a row already shows is not said twice. */
function accountMore(account: InboxAccount, meters: Meter[], repeated: boolean): string[] {
  const resets = meters.flatMap(({ label, window }) => {
    const when = window.clock ?? (window.countdown && `in ${window.countdown}`);
    return when ? [`${label} ${when}`] : [];
  });
  const lines: string[] = [];
  if (account.email) lines.push(account.email);
  if (account.organizationName && !repeated) lines.push(account.organizationName);
  if (resets.length > 0) lines.push(`Resets ${resets.join(' · ')}`);
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

function UsageBar({ meter, lone }: { meter: Meter; lone: boolean }) {
  const shown = Math.round(meter.window.pct);
  return (
    <span className="ib-acct-bar" data-usage={meter.label} data-high={shown >= 90 ? '' : undefined} data-week={meter.week ? '' : undefined} data-lone={lone ? '' : undefined}>
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
  return (
    <span className="ib-acct-use" data-account-use="bars" data-windows={meters.length > 2 ? 'many' : undefined}>
      {meters.map((meter, index) => (
        <UsageBar key={index} meter={meter} lone={!meter.week && others === 1} />
      ))}
    </span>
  );
}

function AccountRow({ account, repeated }: { account: InboxAccount; repeated: boolean }) {
  const [open, setOpen] = useState(false);
  const meters = accountMeters(account);
  const more = accountMore(account, meters, repeated);
  const head = (
    <>
      <span className="ib-acct-who">
        <span className="ib-acct-name">{accountLabel(account)}</span>
        {repeated && account.organizationName && <span className="ib-acct-org">{account.organizationName}</span>}
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
        <AccountRow key={account.number} account={account} repeated={sharesName(accounts, account)} />
      ))}
    </ul>
  );
}

/** This machine and the account it is using. Its Switch comes here in a later step. */
function MachineGroup({ machine, active, accounts }: { machine: string; active: InboxAccount; accounts: InboxAccount[] }) {
  const name = accountLabel(active);
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
            <span>{sharesName(accounts, active) && active.organizationName ? `${name} · ${active.organizationName}` : name}</span>
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * Settings → Accounts (approval "accounts-page", step 1): this computer's
 * Claude accounts and their usage, read-only. A read goes through `cswap` to
 * the Keychain and to Anthropic, so it takes seconds and happens only when
 * this page opens or on Refresh.
 */
export function AccountsSection({ machine }: { /** This machine's name, when this Inbox knows it. */ machine?: string }) {
  const [view, setView] = useState<View | null>(null);
  const [reading, setReading] = useState(true);

  const read = async () => {
    setReading(true);
    try {
      setView(await inboxApi.accounts());
    } catch (cause) {
      setView({ state: cause instanceof InboxApiError && cause.code === 'owner_only' ? 'owner_only' : 'unreachable' });
    } finally {
      setReading(false);
    }
  };
  useEffect(() => {
    void read();
  }, []);

  const active = view?.state === 'accounts' ? view.accounts.find((account) => account.active) : undefined;
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
            <button type="button" className="ib-btn ib-ghost ib-sm" disabled={reading} onClick={() => void read()} data-accounts-refresh="">
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
          </div>
        )}
        {(view?.state === 'failed' || view?.state === 'unreachable') && (
          <p role="alert" data-accounts-failed={view.state === 'failed' ? view.reason : view.state}>
            {FAILURE_TEXT[view.state === 'failed' ? view.reason : view.state]}
          </p>
        )}
        {view?.state === 'owner_only' && <p data-accounts-owner-only="">Owner only.</p>}
      </section>
    </>
  );
}
