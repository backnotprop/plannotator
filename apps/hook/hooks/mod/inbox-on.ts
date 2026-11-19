/**
 * Whether the person turned the Plannotator Inbox on on this computer, as the
 * mod reads it (the rule and the record: inbox-on-contract.ts, a copy of
 * packages/shared/inbox/inbox-on-contract.ts). Until it is on, the mod
 * registers no `plannotator_inbox`, gives no reminder and starts nothing.
 *
 * An install from before the rule has no record: the mod asks the CLI once
 * (`plannotator inbox migrate`, which can read the Inbox's store and edit the
 * notes, and writes the record), only where an Inbox ever ran here. A
 * `plannotator` older than the rule cannot: then the cheap files decide this
 * session (inboxUseFromFiles), and nothing is written.
 */

import type { Host } from './host'
import { INBOX_ON_FILE, inboxOnRecord, inboxUseFromFiles } from './inbox-on-contract'

/** How long the one-time `plannotator inbox migrate` may take (it reads the Inbox's store once). */
export const INBOX_MIGRATE_TIMEOUT_MS = 15_000

export function inboxStatePathOf(dataDir: string): string {
  return `${dataDir}/${INBOX_ON_FILE}`
}

/** Whether the person turned the Inbox on here, decided at the process's first session.start. */
export async function inboxOnAtStart(host: Host, dataDir: string, configText: string | null): Promise<boolean> {
  const readState = () => host.readFile(inboxStatePathOf(dataDir)).catch(() => null)
  let state = await readState()
  let record = inboxOnRecord(state)
  if (record && !record.notes) return record.on
  // No record and no Inbox ever ran here: off, with nothing run and nothing written.
  if (!record && !(await host.exists(`${dataDir}/inbox/inbox.json`).catch(() => false))) return false
  // An install from before the rule, or an off record whose notes are still to go: the CLI settles it once.
  await host.run(['plannotator', 'inbox', 'migrate'], { env: { PLANNOTATOR_DATA_DIR: dataDir }, timeoutMs: INBOX_MIGRATE_TIMEOUT_MS }).catch(() => null)
  state = await readState()
  record = inboxOnRecord(state)
  if (record) return record.on
  const agentsFile = await host.exists(`${dataDir}/inbox/agents.json`).catch(() => false)
  return inboxUseFromFiles({ config: configText, state, agentsFile }) !== null
}

/** Whether the record says off now (turned off since the session started): a call is refused, nothing starts. */
export async function inboxTurnedOff(host: Host, dataDir: string): Promise<boolean> {
  return inboxOnRecord(await host.readFile(inboxStatePathOf(dataDir)).catch(() => null))?.on === false
}
