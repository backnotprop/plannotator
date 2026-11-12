import { describe, expect, test } from 'bun:test'
import type { Host } from './host'
import { sessionProjectFolder } from './inbox'
import { dataDirOf, modTargetFor, subjectFor } from './launch'
import { isAbsolutePath, trimTrailingSeparators } from './paths'
import { isTrustablePlanPath } from './plan'

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
    expect(modTargetFor('review', [], '\\\\srv\\share\\repo\\..\\..\\x')).toBe('//srv/share/x')
  })

  test('trimming separators never turns a root into something else', () => {
    expect(trimTrailingSeparators('/')).toBe('/')
    expect(trimTrailingSeparators('/a/b//')).toBe('/a/b')
    expect(trimTrailingSeparators('C:\\')).toBe('C:\\')
    expect(trimTrailingSeparators('C:/x/')).toBe('C:/x')
  })
})

describe('a POSIX path keeps its backslashes', () => {
  test("a target and a subject read a backslash as part of the name, not a separator", () => {
    expect(modTargetFor('annotate', ['/tmp/notes\\draft.md'], '/tmp')).toBe('/tmp/notes\\draft.md')
    expect(modTargetFor('review', [], '/tmp/a\\..\\b')).toBe('/tmp/a\\..\\b')
    expect(subjectFor('annotate', ['/tmp/notes\\draft.md'])).toBe('notes\\draft.md')
  })
})
