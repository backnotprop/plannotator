import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { InboxAccountsFailure, InboxAccountsRead, InboxMachineAccountsRead } from '@plannotator/core/inbox-types';
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

export interface Accounts {
  /** Null until the first answer. */
  view: AccountsView | null;
  /** A read that failed over a good list, which stays up. */
  refreshFailed: AccountsFailure | null;
  /** This computer's read. A linked machine shows its own in `machines`. */
  reading: boolean;
  /** The linked machines, as of the last read. */
  machines: MachineAccounts[];
  /** Reads now, or joins the read already going. `fresh` (Refresh) skips the answer each Inbox keeps. */
  read: (options?: { fresh?: boolean }) => Promise<void>;
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

function useAccountsRead(): Accounts {
  const [view, setView] = useState<AccountsView | null>(null);
  const [refreshFailed, setRefreshFailed] = useState<AccountsFailure | null>(null);
  const [reading, setReading] = useState(true);
  const [machines, setMachines] = useState<MachineAccounts[]>([]);
  const latest = useRef<AccountsView | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const machineReads = useRef(new Map<string, { again: boolean }>());

  const read = useCallback(({ fresh = false }: { fresh?: boolean } = {}) => {
    void readMachines(fresh, machineReads.current, setMachines);
    const run = async () => {
      setReading(true);
      let next: AccountsView;
      try {
        next = await inboxApi.accounts(fresh);
      } catch (cause) {
        next = { state: cause instanceof InboxApiError && cause.code === 'owner_only' ? 'owner_only' : 'unreachable' };
      }
      const failure = accountsFailure(next);
      const keepList = failure !== null && latest.current?.state === 'accounts';
      setRefreshFailed(keepList ? failure : null);
      if (!keepList) {
        latest.current = next;
        setView(next);
      }
      setReading(false);
    };
    running.current ??= run().finally(() => {
      running.current = null;
    });
    return running.current;
  }, []);

  // The one read nobody asked for: the sidebar has to know whether a limit is near. It never repeats by itself.
  useEffect(() => {
    void read();
  }, [read]);

  return useMemo(() => ({ view, refreshFailed, reading, machines, read }), [view, refreshFailed, reading, machines, read]);
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
