/**
 * Tailscale helper tests — pure parsers and the injectable detection edge.
 *
 * Run: bun test packages/shared/tailscale.test.ts
 *
 * No test here ever spawns the real `tailscale` CLI or touches tailnet state:
 * detection and serve-command construction are exercised through fixtures and
 * an injected runner.
 */

import { describe, expect, test } from "bun:test";
import {
  buildServeArgs,
  buildServeOffArgs,
  describeTailscaleFailure,
  detectTailnetHost,
  extractServeHttpsUrl,
  isAutoUrlHost,
  parseTailscaleIpv4,
  parseTailscaleIpv4Output,
  parseTailscaleStatusDnsName,
  serveStatusHasPort,
  type TailscaleRunResult,
} from "./tailscale";

const ok = (stdout: string): TailscaleRunResult => ({ status: 0, stdout, stderr: "" });

describe("isAutoUrlHost", () => {
  test("matches the sentinel case-insensitively, not hostnames containing it", () => {
    expect(isAutoUrlHost("auto")).toBe(true);
    expect(isAutoUrlHost("AUTO")).toBe(true);
    expect(isAutoUrlHost("auto.example.com")).toBe(false);
    expect(isAutoUrlHost("my-auto-host")).toBe(false);
  });
});

describe("parseTailscaleStatusDnsName", () => {
  test("extracts Self.DNSName and strips the FQDN trailing dot", () => {
    const json = JSON.stringify({ Self: { DNSName: "my-machine.tail1234.ts.net." } });
    expect(parseTailscaleStatusDnsName(json)).toBe("my-machine.tail1234.ts.net");
  });

  test("rejects missing Self, non-string, empty, and invalid-host values", () => {
    expect(parseTailscaleStatusDnsName("{}")).toBeUndefined();
    expect(parseTailscaleStatusDnsName(JSON.stringify({ Self: { DNSName: 42 } }))).toBeUndefined();
    expect(parseTailscaleStatusDnsName(JSON.stringify({ Self: { DNSName: "." } }))).toBeUndefined();
    // A host with whitespace could forge extra output lines; fail closed.
    expect(
      parseTailscaleStatusDnsName(JSON.stringify({ Self: { DNSName: "bad host.ts.net." } })),
    ).toBeUndefined();
  });

  test("rejects unparsable JSON", () => {
    expect(parseTailscaleStatusDnsName("not json")).toBeUndefined();
  });
});

describe("parseTailscaleIpv4", () => {
  test("accepts only canonical CGNAT 100.64.0.0/10 addresses", () => {
    expect(parseTailscaleIpv4("100.64.0.1")).toBe("100.64.0.1");
    expect(parseTailscaleIpv4(" 100.127.255.254 ")).toBe("100.127.255.254");
    expect(parseTailscaleIpv4("100.63.255.255")).toBeUndefined();
    expect(parseTailscaleIpv4("100.128.0.1")).toBeUndefined();
    expect(parseTailscaleIpv4("192.168.1.10")).toBeUndefined();
  });

  test("rejects non-canonical forms (leading zeros, out-of-range, garbage)", () => {
    expect(parseTailscaleIpv4("100.064.0.1")).toBeUndefined();
    expect(parseTailscaleIpv4("100.64.0.256")).toBeUndefined();
    expect(parseTailscaleIpv4("100.64.0")).toBeUndefined();
    expect(parseTailscaleIpv4("tailscale")).toBeUndefined();
  });
});

describe("parseTailscaleIpv4Output", () => {
  test("requires exactly one valid address line", () => {
    expect(parseTailscaleIpv4Output("100.64.12.5\n")).toBe("100.64.12.5");
    expect(parseTailscaleIpv4Output("100.64.12.5\n100.64.12.6\n")).toBeUndefined();
    expect(parseTailscaleIpv4Output("")).toBeUndefined();
  });
});

describe("detectTailnetHost", () => {
  test("prefers the MagicDNS name from status --json", () => {
    const run = (args: string[]) =>
      args[0] === "status"
        ? ok(JSON.stringify({ Self: { DNSName: "vps-1.tail1234.ts.net." } }))
        : ok("100.64.0.9\n");
    expect(detectTailnetHost(run)).toEqual({ host: "vps-1.tail1234.ts.net" });
  });

  test("falls back to the single tailnet IPv4 when status has no usable DNSName", () => {
    const run = (args: string[]) =>
      args[0] === "status" ? ok("{}") : ok("100.64.0.9\n");
    expect(detectTailnetHost(run)).toEqual({ host: "100.64.0.9" });
  });

  test("reports a missing CLI as an install hint, not a crash", () => {
    const enoent = Object.assign(new Error("spawnSync tailscale ENOENT"), { code: "ENOENT" });
    const result = detectTailnetHost(() => ({ error: enoent, status: null, stdout: "", stderr: "" }));
    expect("error" in result && result.error).toContain("not found on PATH");
  });

  test("reports a not-signed-in daemon via stderr detail", () => {
    const result = detectTailnetHost(() => ({ status: 1, stdout: "", stderr: "Logged out." }));
    expect("error" in result && result.error).toContain("Logged out.");
  });

  test("errors when neither DNSName nor a single IPv4 is available", () => {
    const run = () => ok("{}");
    const result = detectTailnetHost(run);
    expect("error" in result).toBe(true);
  });
});

describe("describeTailscaleFailure", () => {
  test("suggests `tailscale up` when the CLI exits non-zero without detail", () => {
    expect(describeTailscaleFailure({ status: 1, stdout: "", stderr: "" })).toContain(
      "tailscale up",
    );
  });
});

describe("serve command construction", () => {
  // These argv shapes are the contract with the `tailscale` CLI; a drift here
  // silently breaks publishing or, worse, cleanup.
  test("serve args proxy the exact loopback port and its teardown matches", () => {
    expect(buildServeArgs(19432)).toEqual([
      "serve",
      "--bg",
      "--https=19432",
      "http://127.0.0.1:19432",
    ]);
    expect(buildServeOffArgs(19432)).toEqual(["serve", "--https=19432", "off"]);
  });
});

describe("serveStatusHasPort", () => {
  test("detects an existing TCP mapping for the port", () => {
    const json = JSON.stringify({
      TCP: { "8443": { HTTPS: true } },
      Web: { "host.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    });
    expect(serveStatusHasPort(json, 8443)).toBe(true);
    expect(serveStatusHasPort(json, 19432)).toBe(false);
  });

  test("treats empty, {} and unparsable status as no existing config", () => {
    expect(serveStatusHasPort("", 19432)).toBe(false);
    expect(serveStatusHasPort("{}", 19432)).toBe(false);
    expect(serveStatusHasPort("No serve config", 19432)).toBe(false);
    expect(serveStatusHasPort(JSON.stringify({ TCP: null }), 19432)).toBe(false);
  });
});

describe("extractServeHttpsUrl", () => {
  test("pulls the https URL out of realistic serve --bg output", () => {
    const output = [
      "Available within your tailnet:",
      "",
      "https://my-machine.tail1234.ts.net:19432/",
      "|-- proxy http://127.0.0.1:19432",
      "",
      "Serve started and running in the background.",
    ].join("\n");
    expect(extractServeHttpsUrl(output)).toBe("https://my-machine.tail1234.ts.net:19432");
  });

  test("returns undefined when no valid https URL is present", () => {
    expect(extractServeHttpsUrl("Serve started.")).toBeUndefined();
    expect(extractServeHttpsUrl("http://127.0.0.1:19432")).toBeUndefined();
  });
});
