import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { InboxAccount, InboxMachineAccountsRead, InboxUsageWindow } from '@plannotator/core/inbox-types';
import { HostMark, Icon } from '../icons';
import { usePhone } from '../phone';
import { accountsFailure, SELF, useAccounts, type AccountsFailure, type AccountSwitch, type AccountsView, type SwitchLine } from '../useAccounts';
import { CodeBox } from './ConnectPicker';

export const FAILURE_TEXT: Record<AccountsFailure, string> = {
  timed_out: 'claude-swap timed out.',
  run_failed: 'claude-swap failed.',
  bad_output: 'claude-swap gave an unreadable answer.',
  unknown_schema: 'Update Plannotator and claude-swap.',
  unreachable: 'The Inbox did not answer.',
};

/**
 * One tool's accounts list on a machine. Claude Code is the only one; Codex
 * goes in as a second entry with its own read, once its accounts are approved.
 */
interface AccountsTool {
  host: string;
  name: string;
  /** The program that reads and switches its logins, as the page names it. */
  swap: string;
  /** The first way its README installs it. */
  install: string;
  /** Saves the login signed in now. */
  add: string;
}

const CLAUDE_CODE: AccountsTool = { host: 'claude-code', name: 'Claude Code', swap: 'claude-swap', install: 'uv tool install claude-swap', add: 'cswap add' };

/** What an account is called: its alias, else the start of its address, else it has neither and is an API key. */
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
  /** `cswap`'s number, only when rows would still read alike. One machine's list, so it is the number `cswap` prints there. */
  number: number | null;
}

export function rowName(accounts: InboxAccount[], account: InboxAccount): RowName {
  const label = accountLabel(account);
  const organization = accountOrganization(account);
  const namesakes = accounts.filter((other) => accountLabel(other) === label);
  const alike = namesakes.filter((other) => accountOrganization(other) === organization);
  return { label, organization: namesakes.length > 1 ? organization : null, number: alike.length > 1 ? account.number : null };
}

/** A name as a sentence says it: the number too, so it names one login. */
const spokenName = ({ label, number }: RowName) => (number === null ? label : `${label} #${number}`);

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

/** A limit as a row shows it. */
export interface Meter {
  label: string;
  window: InboxUsageWindow;
  week?: boolean;
}

/** Only the limits reported: 5h, the scoped ones, and week last. */
export function accountMeters(account: InboxAccount): Meter[] {
  const { usage } = account;
  if (!usage) return [];
  return [
    ...(usage.fiveHour ? [{ label: '5h', window: usage.fiveHour }] : []),
    ...usage.scoped.map((window) => ({ label: window.name, window })),
    ...(usage.sevenDay ? [{ label: 'week', window: usage.sevenDay, week: true }] : []),
  ];
}

/** The limit nearest to running out: the one a row shows. The first of a tie. */
function tightest(account: InboxAccount): Meter | null {
  return accountMeters(account).reduce<Meter | null>((top, meter) => (top && shownPct(top.window) >= shownPct(meter.window) ? top : meter), null);
}

/** States a person has to act on: no other machine's reading stands in for them. */
const NEEDS_A_PERSON = new Set(['relogin_required', 'no_credentials', 'foreign_credential', 'keychain_unavailable']);

/** A reading that can go amber and be compared: not old, and its login not expired. */
const trusted = (account: InboxAccount) => !isStale(account) && account.usageStatus !== 'relogin_required';

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

/** When a limit resets, in the person's own clock: a time today, a weekday this week, else a date. */
function resetText(window: InboxUsageWindow): string | null {
  const at = window.resetsAt ? new Date(window.resetsAt) : null;
  if (at && !Number.isNaN(at.getTime())) {
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const now = new Date();
    if (at.toDateString() === now.toDateString()) return time;
    if (at.getTime() - now.getTime() < 6 * 86_400_000) return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
    return `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }
  return window.clock ?? (window.countdown ? `in ${window.countdown}` : null);
}

/** One login across machines: its address and organization. An API key has no address, so it is no login another machine shares. */
const loginOf = (account: InboxAccount) => (account.email ? `${account.email.toLowerCase()}\n${account.organizationName ?? ''}` : null);

/** "Mac mini", "Mac mini and Studio", "A, B and C". */
const names = (list: string[]) => (list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

/** A machine on the page: this computer first, then each linked one. */
interface PageMachine {
  /** `SELF`, or the linked machine's id. */
  key: string;
  name: string;
  read: AccountsView | InboxMachineAccountsRead | null;
}

/** The other machines whose login in use is `account`: they share its limits. */
function usedElsewhere(machines: PageMachine[], key: string, account: InboxAccount): string[] {
  const login = loginOf(account);
  if (!login) return [];
  return machines.filter((machine) => machine.key !== key && machine.read?.state === 'accounts' && machine.read.accounts.some((other) => other.active && loginOf(other) === login)).map(sayMachine);
}

/**
 * A machine's logins as its list shows them: the one in use first, then the
 * others, most room first, those with no reading after them and API keys
 * last (billed per token). A tie keeps `cswap`'s order.
 */
export function ladder(accounts: InboxAccount[]): { inUse: InboxAccount | null; others: InboxAccount[] } {
  const inUse = accounts.find((account) => account.active) ?? null;
  const rank = (account: InboxAccount) => (account.usageStatus === 'api_key' ? 2 : tightest(account) ? 0 : 1);
  const room = (account: InboxAccount) => {
    const meter = tightest(account);
    return meter ? shownPct(meter.window) : 0;
  };
  const others = accounts.filter((account) => account !== inUse).sort((a, b) => rank(a) - rank(b) || room(a) - room(b) || a.number - b.number);
  return { inUse, others };
}

/**
 * The row with the most room, once the login in use is at 90% or more on a
 * limit it can trust: a login with a trusted reading lower than that, never an
 * API key. Null otherwise. Only a note: switching is the person's.
 */
export function mostRoom(inUse: InboxAccount | null, others: InboxAccount[]): InboxAccount | null {
  const near = inUse && trusted(inUse) ? tightest(inUse) : null;
  if (!near || !isHigh(near.window)) return null;
  let best: { account: InboxAccount; pct: number } | null = null;
  for (const account of others) {
    const meter = account.usageStatus === 'api_key' || !trusted(account) || NEEDS_A_PERSON.has(account.usageStatus ?? '') ? null : tightest(account);
    if (meter && shownPct(meter.window) < shownPct(near.window) && (!best || shownPct(meter.window) < best.pct)) best = { account, pct: shownPct(meter.window) };
  }
  return best?.account ?? null;
}

/**
 * Everything a row keeps off its face, for its hover title: each limit, when
 * the nearest one resets, an old reading's age, "most room", and "API key".
 */
function rowDetail(account: InboxAccount, best: boolean): string {
  if (account.usageStatus === 'api_key') return 'API key, billed per token';
  const meters = accountMeters(account);
  const meter = tightest(account);
  const resets = meter ? resetText(meter.window) : null;
  return [
    meters.map(({ label, window }) => `${label} ${shownPct(window)}%`).join(' · '),
    resets ? `${meter!.label} resets ${resets}` : null,
    isStale(account) ? `Last read ${ageText(account.usageAgeSeconds!)} ago` : null,
    best ? 'Most room' : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The usage cluster, in fixed columns so it lines up down the page: one bar and its figure. An API key or a login with no reading has none. */
function UsageCluster({ account, inUse }: { account: InboxAccount; inUse: boolean }) {
  const meter = account.usageStatus === 'api_key' ? null : tightest(account);
  if (!meter) return <span className="ib-acct-use" data-account-use={account.usageStatus === 'api_key' ? 'api-key' : 'none'} />;
  const shown = shownPct(meter.window);
  const hot = isHigh(meter.window) && trusted(account);
  return (
    <span className="ib-acct-use" data-account-use="bars" data-l={hot ? 'hot' : undefined} data-quiet={inUse ? undefined : ''} data-stale={isStale(account) ? '' : undefined}>
      <i aria-hidden="true" style={{ '--ib-acct-w': `${Math.min(Math.max(shown, 0), 100)}%` } as CSSProperties} />
      <b data-usage={meter.label} aria-label={`${meter.label} ${shown}% used`}>
        {shown}%
      </b>
    </span>
  );
}

/** Why the last switch did not show in the read after it, in the page's few words. */
function switchLineText(line: SwitchLine, label: string): string {
  if (line === 'still_switching') return `Still switching to ${label}. Refresh in a moment.`;
  if (line === 'unconfirmed') return `Switched to ${label}. Refresh to see it.`;
  const why: Record<Exclude<SwitchLine, 'still_switching' | 'unconfirmed'>, string> = {
    run_failed: 'claude-swap failed.',
    timed_out: 'claude-swap timed out.',
    bad_output: 'claude-swap gave an unreadable answer.',
    unknown_schema: 'Update Plannotator and claude-swap.',
    changed: 'The accounts changed. Pick again.',
    renumbered: 'The accounts changed during the switch. The list shows the one in use.',
    busy: 'Another switch is going.',
    not_installed: 'claude-swap is not installed.',
    owner_only: 'Owner only.',
    unreachable: 'The Inbox did not answer.',
  };
  return `Couldn't switch to ${label}. ${why[line]}`;
}

/** A tool's name kept on one line, as the mock sets it: a wrap never breaks "claude-swap" at its hyphen. */
function noBreak(text: string, word: string): ReactNode {
  const parts = text.split(word);
  return parts.flatMap((part, index) => (index === 0 ? [part] : [<span key={index} className="ib-acct-nw">{word}</span>, part]));
}

/** `still_switching` and `unconfirmed` are no failure: the switch may have worked. */
const isFailure = (line: SwitchLine | null) => line !== null && line !== 'still_switching' && line !== 'unconfirmed';

/** What a switch leaves under its row, or above the list when that row is gone. Only a failure offers Try again. */
function SwitchNote({ change, tool, onRetry }: { change: AccountSwitch; tool: AccountsTool; onRetry: (() => void) | null }) {
  const line = change.line!;
  const failed = isFailure(line);
  return (
    <div className="ib-acct-fail" role="alert" data-accounts-switch-failed={line} data-note={failed ? undefined : ''}>
      {failed && <Icon name="excl" size={15} />}
      <span>{noBreak(switchLineText(line, change.label), tool.swap)}</span>
      {failed && onRetry && (
        <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onRetry} data-accounts-retry="">
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * The confirm under a row: one short question, and Cancel or Switch. The
 * block it sits in already names the machine and tool, so only a screen
 * reader hears them; the row's "on <machine>" already says a login is shared.
 * Only money gets a word: an API key is billed per token, and a phone has no
 * hover to tell it. Focus starts on Cancel.
 */
function SwitchConfirm({ title, label, billed, onCancel, onSwitch }: { title: string; label: string; billed: boolean; onCancel: () => void; onSwitch: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="ib-acct-confirm" role="dialog" aria-label={label} data-accounts-confirm="">
      <div>
        <b>{title}</b>
        {billed && <small data-accounts-billed="">Billed per token</small>}
      </div>
      <div className="ib-acct-confirm-acts">
        <button type="button" className="ib-btn ib-ghost ib-sm" ref={cancel} onClick={onCancel} data-accounts-cancel="">
          Cancel
        </button>
        <button type="button" className="ib-btn ib-pri ib-sm" onClick={onSwitch} data-accounts-switch-go="">
          Switch
        </button>
      </div>
    </div>
  );
}

/**
 * The login whose confirm is open: one at a time on the page. Held by the
 * login, not the row's number, so a read after a `cswap swap` in a terminal
 * never moves it to another login; when the login is gone, it closes.
 */
interface Confirming {
  machine: string;
  login: Login;
}

/** A login apart from `cswap`'s number for it: the address, organization and alias the row showed. */
interface Login {
  email: string | null;
  organizationName: string | null;
  alias: string | null;
}

const loginOfRow = (account: InboxAccount): Login => ({ email: account.email ?? null, organizationName: account.organizationName ?? null, alias: account.alias ?? null });
const isLogin = (account: InboxAccount, login: Login) =>
  (account.email ?? null) === login.email && (account.organizationName ?? null) === login.organizationName && (account.alias ?? null) === login.alias;

/** The one row not in use that has `login`, or null: none, or two it can't tell apart (API keys with no alias). */
function rowOfLogin(accounts: InboxAccount[], login: Login): InboxAccount | null {
  const rows = accounts.filter((account) => !account.active && isLogin(account, login));
  return rows.length === 1 ? rows[0]! : null;
}

/** How long the muted "Restart open sessions" line stays under a row after its switch. Its CSS fade ends with it. */
const RESTART_NOTE_MS = 6_000;

/** What this machine is called until the Inbox knows its name. */
const THIS_MACHINE = 'This machine';

/** A machine as a sentence names it. */
const sayMachine = (machine: PageMachine) => (machine.key === SELF && machine.name === THIS_MACHINE ? 'this machine' : machine.name);

/** A machine's list says this in place of rows. */
function Quiet({ children, state }: { children: ReactNode; state: string }) {
  return (
    <div className="ib-acct-quiet" data-machine-state={state}>
      {children}
    </div>
  );
}

const QUIET_WORDS: Record<string, string> = {
  offline: 'Asleep',
  needs_update: 'Update Plannotator',
};

/** Whether `account` is the login a switch named. */
function isTarget(account: InboxAccount, to: AccountSwitch['to']): boolean {
  return account.number === to.number && (account.email ?? null) === to.email && (account.organizationName ?? null) === to.organizationName && (account.alias ?? null) === to.alias;
}

/**
 * One tool's list on one machine: the login in use first, in bold with a
 * filled circle, then the others, muted. Where `canSwitch` allows (never while
 * INBOX_ACCOUNT_SWITCHING is off), each of those is the switch, and pressing
 * one opens the confirm under it; otherwise every row is plain.
 */
function ToolList({
  tool,
  machine,
  machines,
  self,
  phone,
  confirming,
  onConfirm,
}: {
  tool: AccountsTool;
  machine: PageMachine;
  machines: PageMachine[];
  /** This computer's extras: its read's wait, and a failed Refresh over its list. */
  self: { reading: boolean; refreshFailed: AccountsFailure | null } | null;
  phone: boolean;
  confirming: Confirming | null;
  onConfirm: (next: Confirming | null) => void;
}) {
  const { switches, switchTo, canSwitch } = useAccounts();
  const change = switches[machine.key] ?? null;
  const going = change?.going ?? false;
  const rowsRef = useRef<HTMLDivElement>(null);
  // Rows are disabled while a switch goes, so focus falls to the page: it comes back to the list after.
  const wasGoing = useRef(going);
  // A switch that shows in the read after it: its row says once, muted, that open sessions keep the old login.
  const [switched, setSwitched] = useState<number | null>(null);
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (wasGoing.current && !going && lost) {
      const back = change ? rowsRef.current?.querySelector<HTMLElement>(`button[data-account="${change.to.number}"]`) : null;
      (back ?? rowsRef.current)?.focus();
    }
    if (wasGoing.current && !going && change && change.line === null) setSwitched(change.to.number);
    if (going) setSwitched(null);
    wasGoing.current = going;
  }, [going, change]);
  useEffect(() => {
    if (switched === null) return;
    const done = setTimeout(() => setSwitched(null), RESTART_NOTE_MS);
    return () => clearTimeout(done);
  }, [switched]);

  // A read that no longer has the login under its confirm (renumbered, removed, now in use, or no list): it closes.
  const confirmGone = confirming?.machine === machine.key && !(machine.read?.state === 'accounts' && rowOfLogin(machine.read.accounts, confirming.login));
  useEffect(() => {
    if (confirmGone) onConfirm(null);
  }, [confirmGone, onConfirm]);

  const { read } = machine;
  let body: ReactNode = null;
  if (read === null) {
    body = (
      <Quiet state="reading">
        <span role={self ? 'status' : undefined} data-accounts-wait="">
          Reading accounts…
        </span>
      </Quiet>
    );
  } else if (read.state === 'not_installed') {
    body = (
      <div className="ib-acct-miss" data-accounts-missing="">
        <div>
          <b>{tool.swap}</b> isn't installed on {sayMachine(machine)}.
        </div>
        <CodeBox text={tool.install} />
        {/* The Inbox looks only on the PATH it started with, so a Refresh can't find what was installed after that. */}
        <small>Already installed? Restart the Inbox there.</small>
      </div>
    );
  } else if (read.state === 'offline' || read.state === 'needs_update') {
    body = <Quiet state={read.state}>{QUIET_WORDS[read.state]}</Quiet>;
  } else if (read.state === 'failed' || read.state === 'unreachable') {
    const failure = accountsFailure(read)!;
    body = (
      <Quiet state={read.state}>
        {self ? (
          <p role="alert" data-accounts-failed={failure}>
            {FAILURE_TEXT[failure]}
          </p>
        ) : (
          FAILURE_TEXT[failure]
        )}
      </Quiet>
    );
  } else if (read.state === 'accounts' && read.accounts.length === 0) {
    body = (
      <div className="ib-acct-miss" data-accounts-none="">
        <div>Sign in to {tool.name}, then save the account</div>
        <CodeBox text={tool.add} />
      </div>
    );
  } else if (read.state === 'accounts') {
    const { accounts } = read;
    const { inUse, others } = ladder(accounts);
    const best = mostRoom(inUse, others);
    const switchable = canSwitch(machine.key);
    const target = change ? (accounts.find((account) => isTarget(account, change.to)) ?? null) : null;
    const noteHere = change && !change.going && change.line ? change : null;
    const noteUnderRow = noteHere && target && !target.active ? target : null;
    const nameOf = (account: InboxAccount) => rowName(accounts, account);
    const focusRow = (number: number) => rowsRef.current?.querySelector<HTMLElement>(`button[data-account="${number}"]`)?.focus();
    const confirmFor = (account: InboxAccount) => {
      const to = spokenName(nameOf(account));
      return (
        <SwitchConfirm
          title={`Switch to ${to}?`}
          label={`Switch ${tool.name} on ${sayMachine(machine)} to ${to}?`}
          billed={account.usageStatus === 'api_key'}
          onCancel={() => {
            onConfirm(null);
            focusRow(account.number);
          }}
          onSwitch={() => {
            onConfirm(null);
            void switchTo(machine.key, { number: account.number, email: account.email, organizationName: account.organizationName, alias: account.alias }, to);
          }}
        />
      );
    };
    body = (
      <>
        {self?.refreshFailed && (
          <p className="ib-acct-line" role="alert" data-accounts-failed={self.refreshFailed}>
            {FAILURE_TEXT[self.refreshFailed]}
          </p>
        )}
        {noteHere && !noteUnderRow && <SwitchNote change={noteHere} tool={tool} onRetry={null} />}
        <div className="ib-acct-rows" role="group" aria-label={`${tool.name} on ${machine.name}`} aria-busy={self?.reading || going} ref={rowsRef} tabIndex={-1}>
          {[...(inUse ? [inUse] : []), ...others].map((account) => {
            const active = account === inUse;
            const name = nameOf(account);
            const meter = tightest(account);
            const status = account.usageStatus ?? '';
            const on = usedElsewhere(machines, machine.key, account);
            const notes = [
              ...(name.organization ? [name.organization] : []),
              ...(NEEDS_A_PERSON.has(status) || (!meter && status !== 'api_key') ? [noReadingReason(account)] : []),
              ...(on.length > 0 ? [`on ${names(on)}`] : []),
            ];
            const open = !active && confirming?.machine === machine.key && rowOfLogin(accounts, confirming.login) === account;
            const note = noteUnderRow === account ? noteHere : null;
            return (
              <AccountRow
                key={account.number}
                account={account}
                name={name}
                inUse={active}
                notes={notes}
                detail={rowDetail(account, account === best)}
                hot={!!meter && isHigh(meter.window) && trusted(account)}
                switchable={switchable}
                busy={going}
                state={{ confirming: open, going: going && target === account, note }}
                phone={phone}
                onPick={() => onConfirm(open ? null : { machine: machine.key, login: loginOfRow(account) })}
                below={
                  <>
                    {open && confirmFor(account)}
                    {active && switched === account.number && (
                      <small className="ib-acct-after" role="status" data-accounts-restart="">
                        Restart open sessions to use it
                      </small>
                    )}
                    {note &&<SwitchNote change={note} tool={tool} onRetry={() => onConfirm({ machine: machine.key, login: loginOfRow(account) })} />}
                  </>
                }
              />
            );
          })}
        </div>
      </>
    );
  }
  return (
    <div className="ib-acct-tool" data-accounts-tool={tool.host} data-accounts-state={read?.state ?? 'reading'}>
      <div className="ib-acct-th">
        <span className="ib-acct-tl">
          <HostMark host={tool.host} />
          <span>{tool.name}</span>
        </span>
      </div>
      {body}
    </div>
  );
}

/** Each row's own switch state. */
interface RowSwitch {
  /** Its confirm is open. */
  confirming: boolean;
  /** It is the login being switched to. */
  going: boolean;
  /** The switch to it ended with this note. */
  note: AccountSwitch | null;
}

function AccountRow({
  account,
  name,
  inUse,
  notes,
  detail,
  hot,
  switchable,
  busy,
  state,
  phone,
  onPick,
  below,
}: {
  account: InboxAccount;
  name: RowName;
  inUse: boolean;
  notes: string[];
  /** Its limits, reset, age, "most room" or "API key": the hover title, off the row's face. */
  detail: string;
  /** The in-use row at 90% or more on a reading it can trust: its circle goes amber. */
  hot: boolean;
  /** Pressing the row opens its confirm. A machine this build cannot switch (any, while switching is off) has plain rows: no button, no "Switch". */
  switchable: boolean;
  /** A switch is going on this machine: no other starts there. */
  busy: boolean;
  state: RowSwitch;
  phone: boolean;
  onPick: () => void;
  below: ReactNode;
}) {
  const body = (
    <>
      <span
        className="ib-acct-dot"
        data-on={inUse ? '' : undefined}
        data-hot={inUse && hot ? '' : undefined}
        data-pending={state.confirming || state.going ? '' : undefined}
        data-failed={isFailure(state.note?.line ?? null) ? '' : undefined}
      />
      <span className="ib-acct-n">
        <span className="ib-acct-name">
          {name.label}
          {name.number !== null && <span className="ib-acct-num"> #{name.number}</span>}
        </span>
        {notes.length > 0 && <small data-account-notes="">{notes.join(' · ')}</small>}
      </span>
      <UsageCluster account={account} inUse={inUse} />
      {state.going ? (
        <span className="ib-acct-sw" data-going="">
          <span className="ib-spin" aria-hidden="true" />
          {!phone && <span>Switching…</span>}
        </span>
      ) : (
        // The quiet "Switch" that hover shows: a phone has no hover, and its whole row is the tap target.
        <span className="ib-acct-sw" aria-hidden="true">
          {!inUse && switchable && !phone ? 'Switch' : null}
        </span>
      )}
    </>
  );
  return (
    <>
      {inUse || !switchable ? (
        <div className="ib-acct-r" data-account={account.number} data-in-use={inUse ? '' : undefined} title={detail || undefined}>
          {body}
        </div>
      ) : (
        <button type="button" className="ib-acct-r" data-account={account.number} aria-expanded={state.confirming} disabled={busy} onClick={onPick} title={detail || undefined}>
          {body}
        </button>
      )}
      {below}
    </>
  );
}

/** The page's Refresh, beside its title: it reads every machine again. Not for a tailnet guest. */
export function AccountsRefresh() {
  const { view, reading, read } = useAccounts();
  if (view?.state === 'owner_only') return null;
  return (
    <button type="button" className="ib-btn ib-ghost ib-sm ib-acct-refresh" disabled={reading} onClick={() => void read({ fresh: true })} data-accounts-refresh="">
      {reading ? <span className="ib-spin" aria-hidden="true" /> : <Icon name="refresh" size={13} />}
      Refresh
    </button>
  );
}

/**
 * Settings → Accounts (approval "accounts-page", the by-machine list): one
 * block per machine, this one first, and in each one list per tool. A read
 * goes through `cswap` to the Keychain and to Anthropic, so it takes seconds.
 * This page reads when it opens and on Refresh, through the window's one read
 * (useAccounts).
 */
export function AccountsSection({ machine }: { /** This machine's name, when this Inbox knows it. */ machine?: string }) {
  const { view, refreshFailed, reading, machines: linked, read } = useAccounts();
  const phone = usePhone();
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  useEffect(() => {
    void read();
  }, [read]);

  if (view?.state === 'owner_only') {
    return (
      <div className="ib-accts" data-settings-accounts="owner_only">
        <p data-accounts-owner-only="">Owner only.</p>
      </div>
    );
  }
  const machines: PageMachine[] = [{ key: SELF, name: machine ?? THIS_MACHINE, read: view }, ...linked.map(({ id, name, read: answer }) => ({ key: id, name, read: answer }))];
  return (
    <div className="ib-accts" data-settings-accounts={view?.state ?? 'reading'}>
      {machines.map((each, index) => (
        <section className="ib-acct-m" key={each.key} aria-labelledby={`ib-acct-m-${index}`} data-accounts-machine={each.name} data-machine-key={each.key}>
          <h2 className="ib-acct-mh" id={`ib-acct-m-${index}`}>
            <Icon name="system" size={15} />
            {each.name}
          </h2>
          <ToolList
            tool={CLAUDE_CODE}
            machine={each}
            machines={machines}
            self={each.key === SELF ? { reading, refreshFailed } : null}
            phone={phone}
            confirming={confirming}
            onConfirm={setConfirming}
          />
        </section>
      ))}
    </div>
  );
}

