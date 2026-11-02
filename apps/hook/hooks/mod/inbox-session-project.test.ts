/**
 * PLANNOTATOR_SESSION_PROJECT, which the mod exports beside
 * PLANNOTATOR_SESSION_TAG so the session's shell commands (`plannotator inbox
 * call`, `plannotator card`) file where its `plannotator_inbox` tool does.
 * What can regress: the value following the shell's `cd` (the split the audit
 * found, D1), not following a `/cd`, naming a folder that is gone, or a write
 * on every Bash call. Where it lands is proved end to end in
 * packages/server/inbox-project.model.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { PlannotatorMod } from './controller'
import { fakeHost } from './testing/fake-host'

function session(where: { root: string; cwd: string }, inbox: boolean) {
  const host = fakeHost()
  const exported: string[] = []
  host.setSessionProject = async (value) => void exported.push(value)
  for (const folder of ['/w/top', '/w/top/repo', '/w/top/repo/src']) host.files.set(folder, '')
  const mod = new PlannotatorMod(host, {
    sessionId: 's1',
    dataDir: '/data',
    interactive: true,
    root: async () => where.root,
    cwd: async () => where.cwd,
    ...(inbox ? { inboxTools: [] } : {}),
  })
  return { host, mod, exported }
}

describe('the session project its shell inherits', () => {
  for (const inbox of [true, false]) {
    test(`names the root, never the shell's folder; a /cd moves it; written once per change (${inbox ? 'with' : 'without'} the Inbox tool)`, async () => {
      const where = { root: '/w/top', cwd: '/w/top' }
      const { mod, exported } = session(where, inbox)
      try {
        await mod.exportSessionProject()
        where.cwd = '/w/top/repo/src' // a shell cd
        await mod.exportSessionProject()
        await mod.exportSessionProject()
        where.root = where.cwd = '/w/top/repo' // Claude Code's /cd
        await mod.exportSessionProject()
        expect(exported).toEqual(['claude-code:s1:/w/top', 'claude-code:s1:/w/top/repo'])
      } finally {
        mod.dispose()
      }
    })
  }

  test('a start folder that is gone gives way to the working folder, as the tool does', async () => {
    const where = { root: '/w/deleted-scratch', cwd: '/w/top/repo' }
    const { mod, exported } = session(where, true)
    try {
      await mod.exportSessionProject()
      expect(exported).toEqual(['claude-code:s1:/w/top/repo'])
      expect(await mod.inbox!.projectFolder()).toBe('/w/top/repo')
    } finally {
      mod.dispose()
    }
  })

  test('a failed write is tried again on the next call', async () => {
    const where = { root: '/w/top', cwd: '/w/top' }
    const { host, mod, exported } = session(where, false)
    let refuse = true
    host.setSessionProject = async (value) => {
      if (refuse) throw new Error('env.set refused')
      exported.push(value)
    }
    try {
      await mod.exportSessionProject()
      refuse = false
      await mod.exportSessionProject()
      expect(exported).toEqual(['claude-code:s1:/w/top'])
    } finally {
      mod.dispose()
    }
  })
})
