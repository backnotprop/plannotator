import { describe, expect, test } from 'bun:test'
import { engineHasSessionAppend, SESSION_APPEND_MIN_ENGINE } from './inbox'
import { INBOX_SEND_NOW_MIN_ENGINE, inboxEngineTooOldForSendNow } from '@plannotator/core/inbox-types'

describe('engineHasSessionAppend', () => {
  test('the floor and later releases have it; older, development-only and unreadable versions do not', () => {
    expect(SESSION_APPEND_MIN_ENGINE).toBe('2.1.301')
    expect(engineHasSessionAppend('2.1.301')).toBe(true)
    expect(engineHasSessionAppend('2.1.302')).toBe(true)
    expect(engineHasSessionAppend('2.2.0')).toBe(true)
    expect(engineHasSessionAppend('3.0.0')).toBe(true)
    expect(engineHasSessionAppend('2.1.310-dev')).toBe(true)
    expect(engineHasSessionAppend('2.1.300')).toBe(false)
    expect(engineHasSessionAppend('2.1.290-dev')).toBe(false)
    expect(engineHasSessionAppend('2.0.999')).toBe(false)
    expect(engineHasSessionAppend('')).toBe(false)
    expect(engineHasSessionAppend(undefined)).toBe(false)
    expect(engineHasSessionAppend('dev')).toBe(false)
  })

  test("the Inbox's copy of the floor is the mod's", () => {
    expect(INBOX_SEND_NOW_MIN_ENGINE).toBe(SESSION_APPEND_MIN_ENGINE)
    expect(inboxEngineTooOldForSendNow('2.1.300')).toBe(!engineHasSessionAppend('2.1.300'))
    expect(inboxEngineTooOldForSendNow('2.1.301')).toBe(false)
    expect(inboxEngineTooOldForSendNow('dev')).toBe(false)
  })
})
