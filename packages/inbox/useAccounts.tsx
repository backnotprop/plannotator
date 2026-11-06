import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { INBOX_ACCOUNT_SWITCHING, type InboxAccount, type InboxAccountsFailure, type InboxAccountsRead, type InboxAccountSwitch, type InboxAccountSwitchFailure, type InboxAccountSwitchTarget, type InboxMachineAccountsRead } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi } from './api';

/** The read's answer, or why there is none: a tailnet guest, or an Inbox that did not answer. */
export type AccountsView = InboxAccountsRead | { state: 'owner_only' } | { state: 'unreachable' };

export type AccountsFailure = InboxAccountsFailure | 'unreachable';

export function accountsFailure(view: AccountsView): AccountsFailure | null {
  if (view.state === 'failed') return view.reason;
  return view.state === 'unreachable' ? view.state : null;
}

/** A linked machine and what it last answered. Each answers for itself, a machine that does not as `offline`, so a slow one holds up nothing else. */
export interface MachineAccounts {
  id: string;
  name: string;
  /** Null until its first answer. A read keeps the last one up until it answers. */
  read: InboxMachineAccountsRead | null;
}

/**
 * What the Machines group says after a switch that the read after it does not
 * show: why it did not switch, or `still_switching` (the switch outlasted the
 * person's wait and the read after it too), or `unconfirmed` (it switched, and
 * the read after it failed).
 */
export type SwitchLine = InboxAccountSwitchFailure | 'not_installed' | 'owner_only' | 'unreachable' | 'still_switching' | 'unconfirmed';

/** What a switch's machine is called in `switches`: this computer, or a linked machine's id. */
export const SELF = 'self';

/** A machine's last switch. */
export interface AccountSwitch {
  /** `SELF`, or a linked machine's id. */
  machine: string;
  to: InboxAccountSwitchTarget;
  /** What the window called it when it was picked. */
  label: string;
  /** From the pick until the read after the switch answers: the control says "Switching…". */
  going: boolean;
  /** Null while going, once the read after it shows `to` in use, and once any later read answers with a list: the page then shows that read. */
  line: SwitchLine | null;
}

export interface Accounts {
  /** Null until the first answer. */
  view: AccountsView | null;
  /** A read that failed over a good list, which stays up. */
  refreshFailed: AccountsFailure | null;
  /** This computer's read. A linked machine shows its own in `machines`. */
  reading: boolean;
  /** The linked machines, as of the last read. */
  machines: MachineAccounts[];
  /** Reads now, or joins the read already going. `fresh` (Refresh) asks each Inbox to run again, which it does once its last run is 30 s old; sooner it gets the last reading. */
  read: (options?: { fresh?: boolean }) => Promise<void>;
  /** Each machine's last switch, until its next one, by `SELF` or machine id. None before any. */
  switches: Record<string, AccountSwitch>;
  /** Whether the page offers a switch on this machine (`SELF` or an id): none while INBOX_ACCOUNT_SWITCHING is off, else this computer only. */
  canSwitch: (machine: string) => boolean;
  /** Switch a machine's Claude Code to `to`, then read it again: the page shows what that read says, never a guess. */
  switchTo: (machine: string, to: InboxAccountSwitchTarget, label: string) => Promise<void>;
}

type SetMachines = (change: (machines: MachineAccounts[]) => MachineAccounts[]) => void;

/**
 * One machine's read, one at a time. A Refresh that finds it reading asks again
 * when that read ends, so a slow machine holds up its own Refresh and no other.
 */
async function readMachine(id: string, fresh: boolean, going: Map<string, { again: boolean }>, setMachines: SetMachines) {
  const held = going.get(id);
  if (held) {
    held.again ||= fresh;
    return;
  }
  const turn = { again: false };
  going.set(id, turn);
  let ask = fresh;
  do {
    turn.again = false;
    // The call to this Inbox failing says nothing of the machine: it may be wide awake.
    const read = await inboxApi.machineAccounts(id, ask).catch((): InboxMachineAccountsRead => ({ state: 'unreachable' }));
    setMachines((machines) => machines.map((machine) => (machine.id === id ? { ...machine, read } : machine)));
    ask = true;
  } while (turn.again);
  going.delete(id);
}

/** Each linked machine's read, answered as it comes. */
async function readMachines(fresh: boolean, going: Map<string, { again: boolean }>, setMachines: SetMachines) {
  const answer = await inboxApi.machines().catch(() => null);
  if (!answer) return;
  const linked = answer.machines.filter((machine) => !machine.self);
  setMachines((held) => linked.map(({ id, name }) => ({ id, name, read: held.find((machine) => machine.id === id)?.read ?? null })));
  for (const { id } of linked) void readMachine(id, fresh, going, setMachines);
}

/** Whether `account` is the login `to` names: the read after a switch says whether it took. */
const isTarget = (account: InboxAccount, to: InboxAccountSwitchTarget) =>
  account.number === to.number && (account.email ?? null) === to.email && (account.organizationName ?? null) === to.organizationName && (account.alias ?? null) === to.alias;

/**
 * What a switch leaves on the page, from its answer and the read after it. The
 * read has the last word: `to` in use is done whatever the answer said, so a
 * switch that outlasted the wait and then ended is no failure.
 */
export function switchLine(answer: InboxAccountSwitch | { state: 'failed'; reason: 'owner_only' | 'unreachable' }, after: AccountsView, to: InboxAccountSwitchTarget): SwitchLine | null {
  if (after.state === 'accounts' && after.accounts.some((account) => account.active && isTarget(account, to))) return null;
  const readFailed = after.state !== 'accounts';
  if (answer.state === 'switched') return readFailed ? 'unconfirmed' : 'run_failed';
  if (answer.state === 'not_installed') return 'not_installed';
  // The read after a switch waits for it on the server: a read that answered says it ended, and not in `to`.
  if (answer.reason === 'timed_out') return readFailed ? 'still_switching' : 'run_failed';
  return answer.reason;
}

/** No switch while INBOX_ACCOUNT_SWITCHING is off. A linked machine's switch is a later step: this build switches this computer only. */
const canSwitch = (machine: string) => INBOX_ACCOUNT_SWITCHING && machine === SELF;

/** `switches` with `machine`'s line answered by a read that shows a list. */
function clearLine(switches: Record<string, AccountSwitch>, machine: string): Record<string, AccountSwitch> {
  const held = switches[machine];
  return held && !held.going && held.line ? { ...switches, [machine]: { ...held, line: null } } : switches;
}

function useAccountsRead(): Accounts {
  const [view, setView] = useState<AccountsView | null>(null);
  const [refreshFailed, setRefreshFailed] = useState<AccountsFailure | null>(null);
  const [reading, setReading] = useState(true);
  const [machines, setMachines] = useState<MachineAccounts[]>([]);
  const [switches, setSwitches] = useState<Record<string, AccountSwitch>>({});
  const latest = useRef<AccountsView | null>(null);
  /** The last read's own answer, a failure too, which `latest` keeps out while a list is up. */
  const answered = useRef<AccountsView | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const machineReads = useRef(new Map<string, { again: boolean }>());

  const readThis = useCallback(({ fresh = false, machines: andMachines = true }: { fresh?: boolean; machines?: boolean } = {}) => {
    if (andMachines) void readMachines(fresh, machineReads.current, setMachines);
    const run = async () => {
      setReading(true);
      let next: AccountsView;
      try {
        next = await inboxApi.accounts(fresh);
      } catch (cause) {
        next = { state: cause instanceof InboxApiError && cause.code === 'owner_only' ? 'owner_only' : 'unreachable' };
      }
      answered.current = next;
      const failure = accountsFailure(next);
      const keepList = failure !== null && latest.current?.state === 'accounts';
      setRefreshFailed(keepList ? failure : null);
      if (!keepList) {
        latest.current = next;
        setView(next);
      }
      setReading(false);
      // A later good read answers the last switch's line, whatever it said: the list now shows where it is.
      if (next.state === 'accounts') setSwitches((held) => clearLine(held, SELF));
    };
    running.current ??= run().finally(() => {
      running.current = null;
    });
    return running.current;
  }, []);

  const read = useCallback(({ fresh = false }: { fresh?: boolean } = {}) => readThis({ fresh }), [readThis]);

  const switchTo = useCallback(
    async (machine: string, to: InboxAccountSwitchTarget, label: string) => {
      // Off, or a linked machine (a later step): nothing to ask.
      if (!canSwitch(machine)) return;
      const set = (change: AccountSwitch) => setSwitches((held) => ({ ...held, [machine]: change }));
      set({ machine, to, label, going: true, line: null });
      let answer: InboxAccountSwitch | { state: 'failed'; reason: 'owner_only' | 'unreachable' };
      try {
        answer = await inboxApi.switchAccount(to);
      } catch (cause) {
        answer = { state: 'failed', reason: cause instanceof InboxApiError && cause.code === 'owner_only' ? 'owner_only' : 'unreachable' };
      }
      // Never a read that started before the switch ended: it could show the account in use before.
      await running.current;
      // This computer only: a switch here changes nothing on a linked machine.
      await readThis({ machines: false });
      set({ machine, to, label, going: false, line: switchLine(answer, answered.current ?? { state: 'unreachable' }, to) });
    },
    [readThis],
  );

  // The one read nobody asked for: the sidebar has to know whether a limit is near. It never repeats by itself.
  useEffect(() => {
    void read();
  }, [read]);

  return useMemo(() => ({ view, refreshFailed, reading, machines, read, switches, canSwitch, switchTo }), [view, refreshFailed, reading, machines, read, switches, switchTo]);
}

const AccountsContext = createContext<Accounts | null>(null);

/** One read for the window: Settings → Accounts, the sidebar's Usage row and its peek all show this. */
export function AccountsProvider({ children }: { children: ReactNode }) {
  return <AccountsContext.Provider value={useAccountsRead()}>{children}</AccountsContext.Provider>;
}

export function useAccounts(): Accounts {
  const accounts = useContext(AccountsContext);
  if (!accounts) throw new Error('useAccounts needs an AccountsProvider');
  return accounts;
}
