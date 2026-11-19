/**
 * Whether the person turned the Plannotator Inbox on on this computer, as the
 * mod reads it: the same mark and rule as packages/shared/inbox/turned-on.ts
 * (a hooks module imports only its own folder; the rule itself is in
 * inbox-contract.ts, the contract copy). Until it says on, the mod registers
 * no `plannotator_inbox` and gives no reminder.
 */

import type { Host } from './host'
import { INBOX_PERSON_FILES, INBOX_TURNED_ON_FILE, inboxMarkSaysOn, inboxPersonUsedIt } from './inbox-contract'

/** A file's text; undefined when it is not there, null when it is there but cannot be read. */
async function readOf(host: Host, path: string): Promise<string | null | undefined> {
  if (!(await host.exists(path).catch(() => true))) return undefined
  return host.readFile(path).catch(() => null)
}

/** `testOn`: a test run's own variable says a scratch data dir with no mark counts as on (turned-on.ts testRunCountsOn). */
export async function inboxTurnedOnHere(host: Host, dataDir: string, testOn: boolean): Promise<boolean> {
  const markPath = `${dataDir}/inbox/${INBOX_TURNED_ON_FILE}`
  const mark = await readOf(host, markPath)
  if (mark === null) return true
  if (mark !== undefined) return inboxMarkSaysOn(mark)
  if (testOn) return true
  if ((await readOf(host, `${dataDir}/inbox/inbox.json`)) === undefined) return false
  // An install from before the mark: decided once, from cheap files, and written as the mark.
  const inbox: Record<string, string | null | undefined> = {}
  for (const file of INBOX_PERSON_FILES) {
    const path = `${dataDir}/inbox/${file.name}`
    if (file.read) inbox[file.name] = await readOf(host, path)
    else if (file.dir) inbox[file.name] = (await host.exists(path).catch(() => true)) ? '' : undefined
    else if (!(await host.exists(path).catch(() => true))) inbox[file.name] = undefined
    else {
      const size = await host.fileSize(path).catch(() => -1)
      inbox[file.name] = size === null || size === 0 ? undefined : size < 0 ? null : ''
    }
  }
  const text = async (path: string) => {
    const t = await readOf(host, path)
    return t === undefined ? null : t === null ? '{' : t
  }
  const on = inboxPersonUsedIt({ config: await text(`${dataDir}/config.json`), state: await text(`${dataDir}/state.json`), inbox })
  // Another reader may have decided meanwhile, from the same files: its mark stands.
  const written = await readOf(host, markPath)
  if (typeof written === 'string') return inboxMarkSaysOn(written)
  const by = on ? 'update-used' : 'update-agent-only'
  await host.writeFile(markPath, `${JSON.stringify({ on, by, at: new Date(await host.now()).toISOString() })}\n`).catch(() => undefined)
  return on
}
