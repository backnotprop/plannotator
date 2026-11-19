/**
 * Whether the person turned the Plannotator Inbox on on this computer, as the
 * mod reads it (the rule and the record: inbox-on-contract.ts, a copy of
 * packages/shared/inbox/inbox-on-contract.ts). Until it is on, the mod
 * registers no `plannotator_inbox`, gives no reminder and starts nothing.
 *
 * A record decides. Without one:
 *  - no Inbox ever ran here (no `inbox/inbox.json`): off, nothing run or
 *    written;
 *  - an install from before the rule: the mod asks the CLI once
 *    (`plannotator inbox migrate`, which reads the Inbox's store within a
 *    bounded time, writes the record and prints on or off). After that the
 *    record decides, so it never runs at a later session start.
 *  - a `plannotator` older than the rule answers "Unknown inbox option": it
 *    starts the Inbox for anyone and cannot keep the rule anyway, so the mod
 *    keeps today's behaviour (on where an Inbox ran) until the binary updates.
 *  - the run failed or timed out: the cheap files decide this session
 *    (inboxUseFromFiles), and nothing is written.
 */

import type { Host } from './host'
import { INBOX_ON_FILE, inboxOnRecord, inboxUseFromFiles } from './inbox-on-contract'

/** How long the one-time `plannotator inbox migrate` may take (its store read stops at 5 s, INBOX_SCAN_BUDGET_MS). */
export const INBOX_MIGRATE_TIMEOUT_MS = 10_000

export function inboxStatePathOf(dataDir: string): string {
  return `${dataDir}/${INBOX_ON_FILE}`
}

/** A `plannotator` older than the rule, answering `plannotator inbox migrate`. */
export function isPreRuleCliAnswer(text: string): boolean {
  return /unknown inbox option:?\s*migrate/i.test(text)
}

/** Whether the person turned the Inbox on here, decided at the process's first session.start. */
export async function inboxOnAtStart(host: Host, dataDir: string, configText: string | null): Promise<boolean> {
  const readState = () => host.readFile(inboxStatePathOf(dataDir)).catch(() => null)
  const record = inboxOnRecord(await readState())
  if (record) return record.on
  // No record and no Inbox ever ran here: off, with nothing run and nothing written.
  if (!(await host.exists(`${dataDir}/inbox/inbox.json`).catch(() => false))) return false
  // An install from before the rule: the CLI decides it once and writes the record.
  const run = await host
    .run(['plannotator', 'inbox', 'migrate'], { env: { PLANNOTATOR_DATA_DIR: dataDir }, timeoutMs: INBOX_MIGRATE_TIMEOUT_MS })
    .catch(() => null)
  const state = await readState()
  const decided = inboxOnRecord(state)
  if (decided) return decided.on
  const said = run?.exitCode === 0 ? run.stdout.trim() : ''
  if (said === 'on' || said === 'off') return said === 'on'
  if (run && isPreRuleCliAnswer(`${run.stderr}\n${run.stdout}`)) return true
  const agentsFile = await host.exists(`${dataDir}/inbox/agents.json`).catch(() => false)
  return inboxUseFromFiles({ config: configText, state, agentsFile }) !== null
}

/** Whether the record says off now (turned off since the session started): a call is refused, nothing starts. */
export async function inboxTurnedOff(host: Host, dataDir: string): Promise<boolean> {
  return inboxOnRecord(await host.readFile(inboxStatePathOf(dataDir)).catch(() => null))?.on === false
}
