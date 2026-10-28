import { describe, expect, test } from 'bun:test'
import { cameThroughTailscale, cameThroughTailscaleServe, forwardedForIsTailnet, isTailnetAddress, tailnetAudience } from './tailnet-audience'

// #2166: who may use "Ask this session" in a `--tailscale` session. The
// failure guarded: a request through `tailscale serve` reads as local (and so
// skips the owner check), or a login that is not the owner reads as the owner.

const OWNER = 'owner@example.com'
const served = (extra: Record<string, string> = {}) => new Headers({ 'x-forwarded-for': '100.64.0.7', ...extra })

describe('tailnetAudience', () => {
  test('no mark of serve is local, whatever Host or login a client claims', () => {
    expect(tailnetAudience(new Headers({ host: '127.0.0.1:4000' }), OWNER)).toBe('local')
    expect(tailnetAudience(new Headers({ 'x-forwarded-for': '127.0.0.1, ::1' }), OWNER)).toBe('local')
  })

  test('the owner through serve, compared case-insensitively and RFC 2047 decoded', () => {
    expect(tailnetAudience(served({ 'tailscale-user-login': 'Owner@Example.com', 'tailscale-headers-info': 'https://tailscale.com/s/serve-headers' }), OWNER)).toBe('owner')
    expect(tailnetAudience(served({ 'tailscale-user-login': '=?utf-8?q?J=C3=BCrgen@example.com?=' }), 'jürgen@example.com')).toBe('owner')
  })

  test('another login, a tagged device, funnel, an unreadable owner, a malformed login: peer', () => {
    expect(tailnetAudience(served({ 'tailscale-user-login': 'guest@example.com' }), OWNER)).toBe('peer')
    expect(tailnetAudience(served(), OWNER)).toBe('peer')
    expect(tailnetAudience(served({ 'tailscale-user-login': OWNER, 'tailscale-funnel-request': '?1' }), OWNER)).toBe('peer')
    expect(tailnetAudience(served({ 'tailscale-user-login': OWNER }), null)).toBe('peer')
    expect(tailnetAudience(served({ 'tailscale-user-login': '=?utf-8?q?=ZZ?=' }), OWNER)).toBe('peer')
  })

  test('the owner needs a Tailscale X-Forwarded-For: a forged login behind a local proxy is a peer', () => {
    const owner = { 'tailscale-user-login': OWNER }
    expect(tailnetAudience(new Headers({ ...owner, 'x-forwarded-for': '192.168.1.5' }), OWNER)).toBe('peer')
    expect(tailnetAudience(new Headers({ ...owner, 'x-forwarded-for': '100.64.0.9, 192.168.1.5' }), OWNER)).toBe('peer')
    expect(tailnetAudience(new Headers(owner), OWNER)).toBe('peer')
    expect(tailnetAudience(new Headers({ ...owner, 'x-forwarded-for': '[fd7a:115c:a1e0::1]:443' }), OWNER)).toBe('owner')
    expect(tailnetAudience(new Headers({ ...owner, 'x-forwarded-for': '100.127.255.254' }), OWNER)).toBe('owner')
  })

  test('Tailscale addresses', () => {
    for (const yes of ['100.64.0.0', '100.127.255.255', 'fd7a:115c:a1e0::53', 'FD7A:115C:A1E0:ab12::1']) expect([yes, isTailnetAddress(yes)]).toEqual([yes, true])
    for (const no of ['100.63.255.255', '100.128.0.1', '10.0.0.1', '100.64.0.256', 'fd7a:115c:a1e1::1', 'localhost', '']) expect([no, isTailnetAddress(no)]).toEqual([no, false])
    expect(forwardedForIsTailnet(new Headers({ 'x-forwarded-for': '100.64.0.1:51234' }))).toBe(true)
  })

  test('cameThroughTailscale: serve\'s headers or a Tailscale address, never a LAN proxy', () => {
    expect(cameThroughTailscale(new Headers({ 'x-forwarded-for': '100.101.102.103' }))).toBe(true)
    expect(cameThroughTailscale(new Headers({ 'x-forwarded-for': '192.168.1.5, 100.64.0.2' }))).toBe(true)
    expect(cameThroughTailscale(new Headers({ 'tailscale-headers-info': 'x' }))).toBe(true)
    expect(cameThroughTailscale(new Headers({ 'x-forwarded-for': '192.168.1.5' }))).toBe(false)
    expect(cameThroughTailscale(new Headers())).toBe(false)
  })

  test('any one of serve\'s headers marks a request, even without X-Forwarded-For', () => {
    for (const name of ['tailscale-user-login', 'tailscale-headers-info', 'tailscale-funnel-request']) {
      expect(cameThroughTailscaleServe(new Headers({ [name]: 'x' }))).toBe(true)
    }
    expect(cameThroughTailscaleServe(new Headers({ 'x-forwarded-for': '' }))).toBe(true)
    expect(cameThroughTailscaleServe(new Headers())).toBe(false)
  })
})
