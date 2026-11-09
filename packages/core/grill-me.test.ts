// Which skills picked in the Inbox get the grill-me note. The failure this
// guards: a common spelling of someone's grill-me (or Matt Pocock's `grilling`)
// stops getting it, or an unrelated skill whose name merely starts with
// "grill" starts getting it.
import { describe, expect, test } from 'bun:test'
import { isGrillMeSkill } from './grill-me'

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
