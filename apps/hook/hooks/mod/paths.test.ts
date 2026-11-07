import { describe, expect, test } from 'bun:test'
import type { Host } from './host'
import { sessionProjectFolder } from './inbox'
import { dataDirOf, modTargetFor } from './launch'
import { isAbsolutePath, trimTrailingSeparators } from './paths'
import { isTrustablePlanPath } from './plan'

// Claude Code hands a Windows session its folders as `C:\…`, and each check
// below must read them as absolute. Read as relative, the session files under
// no project (the Inbox lists it nowhere), a plan file is never trusted, and a
// data dir set to a Windows folder is ignored.
describe('a Windows path counts as absolute wherever the mod wants one', () => {
  test('drive, UNC and POSIX paths are absolute; relative and drive-relative ones are not', () => {
    for (const path of ['/home/me', 'C:\\Users\\me', 'c:/Users/me', '\\\\server\\share\\repo']) expect(isAbsolutePath(path)).toBe(true)
    for (const path of ['repo', './repo', '~/repo', 'C:repo', '']) expect(isAbsolutePath(path)).toBe(false)
  })

  test("the session's project folder is its Windows root, so the Inbox can file the session", async () => {
    const host = { exists: async (path: string) => path === 'C:\\Users\\me\\repo' } as unknown as Host
    expect(await sessionProjectFolder(host, 'C:\\Users\\me\\repo', null, 'C:\\Users\\me\\repo\\src')).toBe('C:\\Users\\me\\repo')
    expect(await sessionProjectFolder(host, null, null, 'C:\\Users\\me\\elsewhere')).toBe('C:\\Users\\me\\elsewhere')
  })

  test('a plan file under a Windows folder is trusted', () => {
    expect(isTrustablePlanPath('C:\\Users\\me\\.claude\\plans\\curried-skipping-moler.md')).toBe(true)
    expect(isTrustablePlanPath('plans\\x.md')).toBe(false)
  })

  test('PLANNOTATOR_DATA_DIR may name a Windows folder, and a drive root stays a root', () => {
    expect(dataDirOf({ home: 'C:\\Users\\me', dataDir: 'D:\\plannotator\\' })).toBe('D:\\plannotator')
    expect(dataDirOf({ home: 'C:\\Users\\me', dataDir: 'D:\\' })).toBe('D:\\')
    expect(dataDirOf({ home: 'C:\\Users\\me\\' })).toBe('C:\\Users\\me/.plannotator')
  })

  test("a review with no words targets the session's Windows folder, normalized", () => {
    expect(modTargetFor('review', [], 'C:\\Users\\me\\repo\\..\\other')).toBe('C:/Users/me/other')
    // A UNC share is a root like a drive: `..` never climbs out of it.
    expect(modTargetFor('review', [], '\\\\srv\\share\\repo\\..\\..\\x')).toBe('//srv/share/x')
  })

  test('trimming separators never turns a root into something else', () => {
    expect(trimTrailingSeparators('/')).toBe('/')
    expect(trimTrailingSeparators('/a/b//')).toBe('/a/b')
    expect(trimTrailingSeparators('C:\\')).toBe('C:\\')
    expect(trimTrailingSeparators('C:/x/')).toBe('C:/x')
  })
})
