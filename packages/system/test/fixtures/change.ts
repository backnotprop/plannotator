import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangedFile, ChangeFile, SystemFiles } from '../../src/index.ts';

const dir = join(import.meta.dir, 'prs');

export function prFiles(pr: number): ChangeFile[] {
  const counts = new Map<string, [number, number]>();
  for (const line of readFileSync(join(dir, `pr-${pr}.numstat.txt`), 'utf8').trim().split('\n')) {
    const [a, d, path] = line.split('\t');
    counts.set(path!, [Number(a) || 0, Number(d) || 0]);
  }
  return readFileSync(join(dir, `pr-${pr}.txt`), 'utf8').trim().split('\n').map((line) => {
    const [s, a, b] = line.split('\t');
    const path = s![0] === 'R' ? b! : a!;
    const [additions, deletions] = counts.get(path) ?? [0, 0];
    return { path, status: s![0] as ChangeFile['status'], ...(s![0] === 'R' ? { from: a! } : {}), additions, deletions };
  });
}

const cut = (text: string, from: string, to: string) => {
  const a = text.indexOf(from), b = text.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`fixture: "${from}" not found`);
  return text.slice(0, a) + text.slice(b);
};
const swap = (text: string, a: string, b: string) => {
  if (!text.includes(a)) throw new Error(`fixture: "${a}" not found`);
  return text.replace(a, b);
};

export function before2563(files: SystemFiles): SystemFiles {
  let sys = files['system.yaml']!;
  sys = cut(sys, '  it3:\n', '  shim:\n');
  sys = cut(sys, '  i_t3stdio:\n', '  i_shim:\n');
  sys = cut(sys, '  i_wt3:\n', '  i_setup:\n');
  let l201 = files['sheets/L-201.yaml']!;
  l201 = swap(l201, ', it3 2]', ']');
  l201 = swap(l201, ' i_t3stdio,', '');
  l201 = swap(l201, ' i_wt3,', '');
  l201 = l201.split('\n').filter((l) => !l.startsWith('  c: { on: i_wt3')).join('\n');
  const out: SystemFiles = { ...files, 'system.yaml': sys, 'sheets/L-201.yaml': l201 };
  delete out['revisions/PR-2563.yaml'];
  return out;
}

export const OPEN_2563 = `
revision: PR-2563
scope: inbox
title: "The Inbox wakes T3 Code threads"
pr: 2563
repo: github.com/backnotprop/plannotator
date: "2026-11-03"
add:
  parts:
    it3:
      in: inbox
      name: T3 Code
      kind: agent host
      role: Its Claude threads call the tools over MCP; the Inbox sends your reply as a new turn through T3's MCP API.
      sub: t3_thread_send · after plannotator t3 login
      code:
        packages/server/inbox-t3-wake.ts: the T3 wake
        packages/t3-code/auth.ts: "the T3 grant (T3Credentials)"
        apps/hook/server/inbox-mcp-shim.ts: T3CODE_THREAD_ID names the session
  flows:
    i_t3stdio:
      from: it3
      to: shim
      says: MCP over stdio, as host t3
      code: { from: packages/core/inbox-t3.ts, to: apps/hook/server/inbox-mcp-shim.ts }
    i_wt3:
      from: iserver
      to: it3
      says: t3_thread_send
      code: { from: packages/server/inbox-t3-wake.ts, to: packages/t3-code/t3-client.ts }
  place:
    L-201: { it3: { band: agents, after: iqwen, span: 2 } }
change:
  iserver: { says: "Adds t3 to the hosts it wakes: it finds the thread with t3_thread_read and sends your reply with t3_thread_send." }
  shim: { says: "Reads T3CODE_THREAD_ID and files the calls as host t3, session the thread id." }
steps:
  title: A reply wakes a T3 thread
  lanes: [it3, shim, iserver, istore, iwindow]
  hops:
    - { from: it3, to: shim, says: "starts plannotator inbox mcp", is: added }
    - { from: shim, to: iserver, says: "send_message as host t3, the thread id", is: changed }
    - { from: iwindow, to: iserver, says: "you send a reply" }
    - { from: iserver, to: it3, says: "t3_thread_send, a queued turn", is: added }
`;

export const PLAN = `
revision: plan-system
scope: inbox
title: System in the Inbox
add:
  parts:
    isysview:
      in: inbox
      name: System view
      kind: view
      role: One per project; Before, After, Steps.
    ikeeper:
      in: inbox
      name: Drawing keeper
      kind: scheduled job
      role: Redraws when main moves.
  flows:
    i_sysopen: { from: iwindow, to: isysview, says: opens }
    i_keeper: { from: ikeeper, to: isysview, says: redraws }
  place:
    L-201:
      ikeeper: { band: ways, after: ilaunch, span: 3 }
      isysview: { band: core, after: ilinks, span: 3 }
change:
  iwindow: { says: "Reviews gains a System button; a review's card gains the change picture." }
  iserver: "Reads each project's drawing and the gate's touched parts."
`;

export const REMOVES = `
revision: PR-9001
scope: inbox
title: "Drop the relay client"
pr: 9001
repo: github.com/example/plannotator
date: "2026-11-05"
change:
  iserver: "No longer starts the relay client."
remove:
  irelayc: "Phones never shipped; the client goes."
`;

export const TOUCHES: { label: string; files: ChangedFile[] }[] = [
  { label: 'PR 101', files: [{ path: 'packages/shared/daily-ping.ts', status: 'M' }] },
  { label: 'PR 102', files: [{ path: 'packages/server/inbox.ts', status: 'M' }] },
  { label: 'PR 103', files: [{ path: 'packages/server/inbox.ts', status: 'M' }, { path: 'packages/ui/utils/sharing.ts', status: 'M' }] },
];
