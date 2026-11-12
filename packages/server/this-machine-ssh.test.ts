/**
 * A remote session that only SSH turned on decides per request: its own
 * tunnel (a loopback TCP peer, loopback Host, no proxy header) is answered as
 * a local session; every other request, and every request under
 * PLANNOTATOR_REMOTE=1, as remote mode. The peer, not a header, decides.
 */
import { afterEach, expect, test } from "bun:test";
import { isLoopbackPeerAddress } from "@plannotator/shared/this-machine-reader";
import { isSshTunnelRequest, isThisMachineRequest, notePeer } from "./this-machine";

const saved = { remote: process.env.PLANNOTATOR_REMOTE, ssh: process.env.SSH_CONNECTION, tty: process.env.SSH_TTY };
afterEach(() => {
  for (const [key, value] of [["PLANNOTATOR_REMOTE", saved.remote], ["SSH_CONNECTION", saved.ssh], ["SSH_TTY", saved.tty]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const from = (address: string, headers: Record<string, string> = { host: "localhost:19432" }) => {
  const req = new Request("http://localhost:19432/api/doc", { headers });
  notePeer(req, { requestIP: () => ({ address }) });
  return req;
};

test("loopback peers: 127/8, ::1 and mapped IPv4; nothing else", () => {
  for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackPeerAddress(a)).toBe(true);
  for (const a of ["192.168.1.5", "10.0.0.1", "::ffff:192.168.1.5", "fe80::1", "", null, undefined]) expect(isLoopbackPeerAddress(a)).toBe(false);
});

test("SSH: the tunnel is this machine; another address, a proxy header, or PLANNOTATOR_REMOTE=1 is not", () => {
  delete process.env.PLANNOTATOR_REMOTE;
  process.env.SSH_CONNECTION = "10.0.0.2 51000 10.0.0.1 22";
  expect(isSshTunnelRequest(from("127.0.0.1"))).toBe(true);
  expect(isThisMachineRequest(from("127.0.0.1"))).toBe(true);
  // A LAN peer claiming a loopback Host is still the network.
  expect(isSshTunnelRequest(from("192.168.1.5"))).toBe(false);
  expect(isThisMachineRequest(from("192.168.1.5"))).toBe(false);
  // A proxy on this machine forwarding someone else.
  expect(isSshTunnelRequest(from("127.0.0.1", { host: "localhost:19432", "x-forwarded-for": "203.0.113.9" }))).toBe(false);
  // A request whose peer was never noted is not the tunnel.
  expect(isSshTunnelRequest(new Request("http://localhost:19432/", { headers: { host: "localhost:19432" } }))).toBe(false);
  process.env.PLANNOTATOR_REMOTE = "1";
  expect(isSshTunnelRequest(from("127.0.0.1"))).toBe(false);
  expect(isThisMachineRequest(from("127.0.0.1"))).toBe(false);
});
