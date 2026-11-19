/**
 * Whether the person turned the Plannotator Inbox on on this computer, as the
 * mod reads it: the same mark and rule as packages/shared/inbox/turned-on.ts
 * (a hooks module imports only its own folder; the mark's name and reading are
 * in inbox-contract.ts, the contract copy). Until it says on, the mod
 * registers no `plannotator_inbox` and gives no reminder. Where an Inbox ran
 * here (`inbox/inbox.json`: from before the mark, or started by an older
 * `plannotator` that knows no mark), it is on, and the mark is written on.
 */

import type { Host } from './host'
import { INBOX_TURNED_ON_FILE, inboxMarkSaysOn } from './inbox-contract'

/** A file's text; undefined when it is not there, null when it is there but cannot be read. */
async function readOf(host: Host, path: string): Promise<string | null | undefined> {
  if (!(await host.exists(path).catch(() => true))) return undefined
  return host.readFile(path).catch(() => null)
}

/** `testOn`: a test run's own variable says a data dir with no mark counts as on (turned-on.ts testRunCountsOn). */
export async function inboxTurnedOnHere(host: Host, dataDir: string, testOn: boolean): Promise<boolean> {
  const markPath = `${dataDir}/inbox/${INBOX_TURNED_ON_FILE}`
  const mark = await readOf(host, markPath)
  if (mark === null) return true
  if (mark !== undefined) return inboxMarkSaysOn(mark)
  if (testOn) return true
  // Written only where inbox.json was seen to be there; a check that fails answers on and writes nothing.
  let ran: boolean
  try {
    ran = await host.exists(`${dataDir}/inbox/inbox.json`)
  } catch {
    return true
  }
  if (!ran) return false
  // The host has no exclusive write; the mod only ever writes "on", so a race with another writer cannot turn it off.
  if (!(await host.exists(markPath).catch(() => true))) {
    const at = new Date(await host.now()).toISOString()
    await host.writeFile(markPath, `${JSON.stringify({ on: true, by: 'update-existing', at })}\n`).catch(() => undefined)
  }
  return true
}
