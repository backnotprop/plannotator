// Which skill runs get the grill-me note. The failure this guards: a common
// spelling of someone's grill-me (or Matt Pocock's hand-over to `grilling`)
// stops getting the note, or an unrelated skill whose name merely starts with
// "grill" starts getting it.
import { describe, expect, test } from 'bun:test'
import { GRILL_ME_NOTE_TEXT, GRILL_ME_NOTE_TEXT_NO_WAKE, grillMeNoteText, isGrillMeSkill } from './grill-me'

describe('isGrillMeSkill', () => {
  test('any author\'s grill-me, however it is spelled or namespaced', () => {
    for (const name of [
      'grill-me',
      'grill_me',
      'grillme',
      'GrillMe',
      'Grill-Me',
      'grill me',
      '/grill-me',
      '$grill-me',
      'mattpocock:grill-me',
      'team-skills:grill_me',
      'grill-me-harder',
      'grill-me-codex',
      'odoo-grill-me',
      'rpi-grillme',
      'grillme-gestor',
      'grilling',
      'skills:grilling',
      'grill',
      'grill-with-docs',
    ]) {
      expect([name, isGrillMeSkill(name)]).toEqual([name, true])
    }
  })

  test('never a skill that only shares the letters', () => {
    for (const name of ['grilled-cheese', 'grill-menu', 'grillcraft', 'bbq-grill', 'grill-master', 'prompt-grill', 'me-grill', 'grilled', 'review', '', '   ', ':', 'grill-me:review']) {
      expect([name, isGrillMeSkill(name)]).toEqual([name, false])
    }
    for (const value of [undefined, null, 42, { name: 'grill-me' }]) expect(isGrillMeSkill(value)).toBe(false)
  })
})

describe('grillMeNoteText', () => {
  test('names the tool the host registered, once, and nothing else changes', () => {
    const full = 'mcp__plugin_plannotator_tools__plannotator_inbox'
    const text = grillMeNoteText(full)
    expect(text).toBe(GRILL_ME_NOTE_TEXT.replace('plannotator_inbox', full))
    expect(text.split(full).length).toBe(2)
    expect(grillMeNoteText()).toBe(GRILL_ME_NOTE_TEXT)
  })

  test('a host without the reply wake says to read the thread instead of waiting for a message', () => {
    expect(GRILL_ME_NOTE_TEXT_NO_WAKE).not.toBe(GRILL_ME_NOTE_TEXT)
    expect(GRILL_ME_NOTE_TEXT_NO_WAKE).toContain('read_thread')
    expect(GRILL_ME_NOTE_TEXT_NO_WAKE).not.toContain('come back here as a message')
    expect(grillMeNoteText('plannotator_inbox', { wakes: false })).toBe(GRILL_ME_NOTE_TEXT_NO_WAKE)
  })
})
