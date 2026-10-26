import { describe, expect, test } from 'bun:test'
import { PlannotatorMod, STORE_LAUNCHES } from './controller'
import { parseReadyFile } from './launch'
import { shellTakeOver } from './take-over'
import { isOlderCliTailscaleRefusal, PLANNOTATOR_TOOL_TAILSCALE_UNAVAILABLE_TEXT } from './tool'
import { fakeHost, type FakeHost, type RunCall } from './testing/fake-host'

// #2166: the tool's `tailscale` option opens the review with the CLI's
// `--tailscale`, and the mod never hands Claude a tailnet review whose CLI
// could not keep "Ask this session" there (an older CLI): it says so.

const SESSION = { sessionId: 'session-1', dataDir: '/data', interactive: true }

function launchDirOf(call: RunCall): string {
  return call.argv[4] as string
}

function isLaunch(call: RunCall): boolean {
  return call.argv[0] === '/bin/sh' && call.argv[3] === 'plannotator-launch'
}

function launches(host: FakeHost): RunCall[] {
  return host.runs.filter(isLaunch)
}

function stops(host: FakeHost): RunCall[] {
  return host.runs.filter((call) => call.argv[3] === 'plannotator-stop')
}

/** Every launch comes up with this ready line (`tailnet` as a current CLI writes it under --tailscale). */
function serveWith(host: FakeHost, ready: Record<string, unknown>) {
  host.onRun = (call) => {
    if (!isLaunch(call)) return
    host.files.set(`${launchDirOf(call)}/ready`, `${JSON.stringify(ready)}\n`)
    host.files.set(`${launchDirOf(call)}/pid`, '4242')
  }
}

const TAILNET_URL = 'https://studio.tail0000.ts.net:6060/'

describe('the plannotator tool: tailscale', () => {
  test('annotate, review and last carry --tailscale to the CLI; the result says where it is served', async () => {
    const host = fakeHost()
    serveWith(host, { url: TAILNET_URL, isRemote: false, port: 6060, tailnet: { ask: true } })
    host.transcript = [{ role: 'assistant', text: 'Here is the design.' }]
    const mod = new PlannotatorMod(host, SESSION)

    const annotate = await mod.runTool({ action: 'annotate', target: 'notes.md', gate: true, tailscale: true })
    await mod.runTool({ action: 'review', target: '../wt', options: { base: 'main' }, tailscale: true })
    await mod.runTool({ action: 'last', tailscale: true })

    const [a, r, l] = launches(host)
    expect(a?.argv.slice(5)).toEqual(['plannotator', 'annotate', 'notes.md', '--gate', '--tailscale'])
    expect(r?.argv.slice(5)).toEqual(['plannotator', 'review', '--base', 'main', '--tailscale', '../wt'])
    expect(l?.argv.slice(5)).toEqual(['plannotator', 'annotate-last', '--stdin', '--tailscale'])
    expect('text' in annotate && annotate.text).toContain(TAILNET_URL)
    expect('text' in annotate && annotate.text).toContain('served over the user\'s tailnet')
    expect('text' in annotate && annotate.text).toContain('only for the Tailscale login that owns this computer')
    expect(stops(host)).toHaveLength(0)
  })

  test('a CLI that could not read the owner: the result says Ask this session is not on the other device', async () => {
    const host = fakeHost()
    serveWith(host, { url: TAILNET_URL, isRemote: false, port: 6060, tailnet: { ask: false } })
    const mod = new PlannotatorMod(host, SESSION)
    const answer = await mod.runTool({ action: 'annotate', target: 'notes.md', tailscale: true })
    expect('text' in answer && answer.text).toContain('not available on the other device')
  })

  test('an older CLI (no tailnet field in its ready line): the review is stopped and the tool says to update', async () => {
    const host = fakeHost()
    // A CLI from before #2166 publishes but drops the bridge; one from before
    // --tailscale opens a plain local session. Neither writes `tailnet`.
    for (const url of [TAILNET_URL, 'http://localhost:6060']) {
      serveWith(host, { url, isRemote: false, port: 6060 })
      const mod = new PlannotatorMod(host, { ...SESSION, sessionId: `session-${url.length}` })
      const answer = await mod.runTool({ action: 'annotate', target: 'notes.md', tailscale: true })
      expect(answer).toEqual({ deny: PLANNOTATOR_TOOL_TAILSCALE_UNAVAILABLE_TEXT })
    }
    expect(stops(host).map((call) => call.argv[4])).toEqual(['4242', '4242'])
    expect(host.store.get(STORE_LAUNCHES)).toEqual([])
  })

  test('a CLI that refuses the flag at startup: the tool says to update, not the CLI\'s words', async () => {
    const host = fakeHost()
    host.onRun = (call) => {
      if (!isLaunch(call)) return
      host.files.set(`${launchDirOf(call)}/stderr`, 'File not found: --tailscale')
      host.files.set(`${launchDirOf(call)}/exit`, '1')
    }
    const mod = new PlannotatorMod(host, SESSION)
    expect(await mod.runTool({ action: 'annotate', target: 'notes.md', tailscale: true })).toEqual({ deny: PLANNOTATOR_TOOL_TAILSCALE_UNAVAILABLE_TEXT })
  })

  test('a current CLI\'s publish failure (Tailscale off, signed out, port routed) is shown as it is', async () => {
    const host = fakeHost()
    const reason = '--tailscale: Tailscale is not running. Start it, then try again.'
    host.onRun = (call) => {
      if (!isLaunch(call)) return
      host.files.set(`${launchDirOf(call)}/stderr`, `[plannotator] Ask this session: on here, and over your tailnet for o@example.com only.\n${reason}`)
      host.files.set(`${launchDirOf(call)}/exit`, '1')
    }
    const mod = new PlannotatorMod(host, SESSION)
    const answer = await mod.runTool({ action: 'review', tailscale: true })
    expect('deny' in answer && answer.deny).toContain(reason)
    expect('deny' in answer && answer.deny).not.toBe(PLANNOTATOR_TOOL_TAILSCALE_UNAVAILABLE_TEXT)
  })

  test('an older CLI\'s refusals of the flag read as "update"; nothing else does', () => {
    expect(isOlderCliTailscaleRefusal('Plannotator could not open notes.md (exit 1):\nFile not found: --tailscale')).toBe(true)
    expect(isOlderCliTailscaleRefusal('--tailscale is only supported with: plannotator review, annotate, annotate-last (last)')).toBe(true)
    expect(isOlderCliTailscaleRefusal('error: unknown option --tailscale')).toBe(true)
    expect(isOlderCliTailscaleRefusal('--tailscale: could not start tailscale serve. Log in to Tailscale first')).toBe(false)
    expect(isOlderCliTailscaleRefusal('--tailscale: tailscale serve already routes port 6060')).toBe(false)
    expect(isOlderCliTailscaleRefusal('File not found: notes.md')).toBe(false)
  })

  test('a launch that answered "starting" and came up later without the tailnet field: the session is told', async () => {
    const host = fakeHost()
    const mod = new PlannotatorMod(host, SESSION)
    // No ready line within the wait: the tool answers "starting".
    const answer = await mod.runTool({ action: 'annotate', target: 'notes.md', tailscale: true })
    expect('text' in answer && answer.text).toContain('Plannotator is starting')
    const dir = launchDirOf(launches(host)[0]!)
    host.files.set(`${dir}/ready`, `${JSON.stringify({ url: 'http://localhost:6060', isRemote: false, port: 6060 })}\n`)
    await host.tick()
    expect(host.logs.some((line) => line.includes('too old to keep "Ask this session" over the tailnet'))).toBe(true)
  })

  test('without tailscale nothing changes: no flag, no ready check, the same result text', async () => {
    const host = fakeHost()
    // An older CLI's ready line (no `tailnet`): fine when tailscale was not asked for.
    serveWith(host, { url: 'http://localhost:6060', isRemote: false, port: 6060 })
    const mod = new PlannotatorMod(host, SESSION)
    const answer = await mod.runTool({ action: 'annotate', target: 'notes.md', tailscale: false })
    expect(launches(host)[0]?.argv.slice(5)).toEqual(['plannotator', 'annotate', 'notes.md'])
    expect('text' in answer && answer.text).not.toContain('tailnet')
    expect(stops(host)).toHaveLength(0)
  })

  test('list and close take no tailscale', async () => {
    const mod = new PlannotatorMod(fakeHost(), SESSION)
    const answer = await mod.runTool({ action: 'list', tailscale: true })
    expect('deny' in answer && answer.deny).toContain('tailscale is for actions')
  })

  test('the slash command passes --tailscale on, for last too, and checks nothing', async () => {
    const host = fakeHost()
    serveWith(host, { url: 'http://localhost:6060', isRemote: false, port: 6060 })
    host.transcript = [{ role: 'assistant', text: 'Hi.' }]
    const mod = new PlannotatorMod(host, SESSION)
    await mod.runCommand('last', '--tailscale')
    await mod.runCommand('last', '')
    const [withFlag, plain] = launches(host)
    expect(withFlag?.argv.slice(5)).toEqual(['plannotator', 'annotate-last', '--stdin', '--tailscale'])
    expect(plain?.argv.slice(5)).toEqual(['plannotator', 'annotate-last', '--stdin'])
    expect(stops(host)).toHaveLength(0)
  })

  test('an agent-run `plannotator ... --tailscale` is taken over as the tool call', () => {
    expect(shellTakeOver('plannotator review --tailscale', false)).toEqual({ action: 'review', tailscale: true })
    expect(shellTakeOver('plannotator annotate notes.md --gate --tailscale --json', false)).toEqual({
      action: 'annotate',
      target: 'notes.md',
      gate: true,
      tailscale: true,
    })
    expect(shellTakeOver('plannotator last --tailscale', false)).toEqual({ action: 'last', tailscale: true })
    // A subagent's command still runs as written.
    expect(shellTakeOver('plannotator review --tailscale', true)).toBeNull()
  })

  test('the ready line\'s tailnet field is read only when well formed', () => {
    const base = { url: TAILNET_URL, isRemote: false, port: 1 }
    expect(parseReadyFile(JSON.stringify({ ...base, tailnet: { ask: true } }))?.tailnet).toEqual({ ask: true })
    expect(parseReadyFile(JSON.stringify({ ...base, tailnet: { ask: 'yes' } }))?.tailnet).toBeUndefined()
    expect(parseReadyFile(JSON.stringify(base))?.tailnet).toBeUndefined()
  })
})
