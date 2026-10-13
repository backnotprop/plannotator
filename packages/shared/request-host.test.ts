import { describe, expect, test } from "bun:test";
import {
  forwardedPortHostPatterns,
  hostnameFromHostHeader,
  hostNotAllowedMessage,
  isAllowedRequestHost,
  isIpLiteralHostname,
  machineHostnames,
  parseAllowedHosts,
} from "./request-host";

const local = { remote: false };
const remote = { remote: true };

describe("isAllowedRequestHost", () => {
  test("loopback names are allowed in local and remote mode, with or without a port", () => {
    for (const host of ["localhost:1234", "LOCALHOST:1234", "localhost", "127.0.0.1:1234", "127.8.9.10:80", "[::1]:1234", "[::1]", "app.localhost:5173", "localhost.:1234"]) {
      expect([host, isAllowedRequestHost(host, local)]).toEqual([host, true]);
      expect([host, isAllowedRequestHost(host, remote)]).toEqual([host, true]);
    }
  });

  test("the port is not compared (forwarded ports arrive with another one)", () => {
    expect(isAllowedRequestHost("localhost:9", local)).toBe(true);
    expect(isAllowedRequestHost("127.0.0.1:65535", local)).toBe(true);
  });

  test("other names are refused in local mode, including names that only look like loopback", () => {
    for (const host of ["evil.example:1234", "evil.example", "127.0.0.1.evil.example:1234", "localhost.evil.example", "192.168.1.20:19432", "[fd7a::1]:19432", "0.0.0.0:1234"]) {
      expect([host, isAllowedRequestHost(host, local)]).toEqual([host, false]);
    }
  });

  test("remote mode allows IPv4 and IPv6 literals but still refuses DNS names", () => {
    expect(isAllowedRequestHost("192.168.1.20:19432", remote)).toBe(true);
    expect(isAllowedRequestHost("10.0.0.5", remote)).toBe(true);
    expect(isAllowedRequestHost("[fd7a:115c:a1e0::1]:19432", remote)).toBe(true);
    expect(isAllowedRequestHost("evil.example:19432", remote)).toBe(false);
    expect(isAllowedRequestHost("999.1.1.1:19432", remote)).toBe(false);
  });

  test("extra hosts (urlHost, machine hostname, tailscale serve name) are allowed by exact name", () => {
    const policy = { remote: true, extraHosts: ["devbox.tailnet.ts.net", "Devbox"] };
    expect(isAllowedRequestHost("devbox.tailnet.ts.net:19432", policy)).toBe(true);
    expect(isAllowedRequestHost("DEVBOX:19432", policy)).toBe(true);
    expect(isAllowedRequestHost("x.devbox.tailnet.ts.net:19432", policy)).toBe(false);
    // A local --tailscale session: only loopback plus the served name.
    expect(isAllowedRequestHost("devbox.tailnet.ts.net:4443", { remote: false, extraHosts: ["devbox.tailnet.ts.net"] })).toBe(true);
  });

  test("a missing Host is allowed (non-browser client); a malformed one is refused", () => {
    expect(isAllowedRequestHost(undefined, local)).toBe(true);
    expect(isAllowedRequestHost(null, local)).toBe(true);
    expect(isAllowedRequestHost("", local)).toBe(true);
    for (const host of ["localhost:abc", "localhost:99999", "user@localhost", "[::1", "::1", "localhost:1:2", "[localhost]:1", " :1234", "local host"]) {
      expect([host, isAllowedRequestHost(host, local)]).toEqual([host, false]);
    }
  });

  test("PLANNOTATOR_ALLOWED_HOSTS adds exact names and dotted suffixes; * turns the check off", () => {
    const allowed = parseAllowedHosts(" Preview.Example.com , .internal.test,,");
    expect(allowed).toEqual({ any: false, names: ["preview.example.com", ".internal.test"] });
    const policy = { remote: false, allowed };
    expect(isAllowedRequestHost("preview.example.com:443", policy)).toBe(true);
    expect(isAllowedRequestHost("a.internal.test", policy)).toBe(true);
    expect(isAllowedRequestHost("internal.test", policy)).toBe(true);
    expect(isAllowedRequestHost("evilinternal.test", policy)).toBe(false);
    expect(isAllowedRequestHost("evil.example", policy)).toBe(false);
    expect(isAllowedRequestHost("evil.example", { remote: false, allowed: parseAllowedHosts("*") })).toBe(true);
    expect(parseAllowedHosts(undefined)).toEqual({ any: false, names: [] });
    // A port on an entry is dropped, not a reason to ignore the entry.
    expect(parseAllowedHosts("proxy.example.com:8443,[fd00::1]:80")).toEqual({ any: false, names: ["proxy.example.com", "fd00::1"] });
  });

  test("a browser IDE's port-proxy hostnames (VSCODE_PROXY_URI) are allowed in local mode, and nothing near them", () => {
    const portHostPatterns = forwardedPortHostPatterns("https://{{port}}--main--ws--me.coder.example.com/");
    const policy = { remote: false, portHostPatterns };
    expect(isAllowedRequestHost("19432--main--ws--me.coder.example.com", policy)).toBe(true);
    expect(isAllowedRequestHost("5173--main--ws--me.coder.example.com:443", policy)).toBe(true);
    for (const host of ["x--main--ws--me.coder.example.com", "--main--ws--me.coder.example.com", "123456--main--ws--me.coder.example.com", "1--main--ws--me.coder.example.com.evil.example", "evil.example"]) {
      expect([host, isAllowedRequestHost(host, policy)]).toEqual([host, false]);
    }
    expect(isAllowedRequestHost("8080.code.example.com", { remote: false, portHostPatterns: forwardedPortHostPatterns("https://{{port}}.code.example.com") })).toBe(true);
    // No template in the hostname (path-based proxy), no domain, or not a URL: nothing.
    expect(forwardedPortHostPatterns("./proxy/{{port}}/")).toEqual([]);
    expect(forwardedPortHostPatterns("https://code.example.com/proxy/{{port}}/")).toEqual([]);
    expect(forwardedPortHostPatterns("https://{{port}}/")).toEqual([]);
    expect(forwardedPortHostPatterns("https://{{port}}-{{port}}.example.com/")).toEqual([]);
    expect(forwardedPortHostPatterns("https://{{port}}.ex ample.com/")).toEqual([]);
    expect(forwardedPortHostPatterns(undefined)).toEqual([]);
  });
});

describe("helpers", () => {
  test("hostname extraction", () => {
    expect(hostnameFromHostHeader("Example.COM.:80")).toBe("example.com");
    expect(hostnameFromHostHeader("[::1]:1")).toBe("::1");
    expect(hostnameFromHostHeader(undefined)).toBeUndefined();
    expect(hostnameFromHostHeader("bad host")).toBeNull();
  });

  test("IP literal detection", () => {
    expect(isIpLiteralHostname("192.168.0.1")).toBe(true);
    expect(isIpLiteralHostname("fd7a::1")).toBe(true);
    expect(isIpLiteralHostname("256.0.0.1")).toBe(false);
    expect(isIpLiteralHostname("1.2.3.4.example")).toBe(false);
  });

  test("machine hostnames: full name, first label and its mDNS .local name", () => {
    expect(machineHostnames("DevBox.local")).toEqual(["devbox.local", "devbox"]);
    expect(machineHostnames("devbox")).toEqual(["devbox", "devbox.local"]);
    expect(machineHostnames("devbox.lan")).toEqual(["devbox.lan", "devbox", "devbox.local"]);
    expect(machineHostnames("10.0.0.5")).toEqual([]);
    expect(machineHostnames("")).toEqual([]);
  });

  test("the refusal names the env var and never echoes a malformed header", () => {
    expect(hostNotAllowedMessage("evil.example:1")).toContain("PLANNOTATOR_ALLOWED_HOSTS");
    expect(hostNotAllowedMessage("evil.example:1")).toContain('"evil.example"');
    expect(hostNotAllowedMessage("<script>")).not.toContain("<script>");
  });
});
