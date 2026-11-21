/**
 * Remote Detection & Port Config Tests
 *
 * Run: bun test packages/server/remote.test.ts
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalOnlyAdvertisedUrl } from "@plannotator/shared/advertised-url";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";
import {
  isAddressInUseError,
  isRemoteSession,
  getServerHostname,
  getServerPort,
  getServerPorts,
  startBunServerOnAvailablePort,
  buildAdvertisedUrl,
  getLocalUrlHostname,
  PortInUseError,
} from "./remote";

// Save and restore env between tests
const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_PORT",
  "SSH_TTY",
  "SSH_CONNECTION",
  "PLANNOTATOR_URL_HOST",
  "PLANNOTATOR_PUBLIC_URL",
  "PLANNOTATOR_DATA_DIR",
];

// The advertised URL reads config.json; point it at an empty sandbox, never
// the developer's real ~/.plannotator.
const SANDBOX_DATA_DIR = mkdtempSync(join(tmpdir(), "plannotator-remote-test-"));
afterAll(() => rmSync(SANDBOX_DATA_DIR, { recursive: true, force: true }));

function clearEnv() {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PLANNOTATOR_DATA_DIR = SANDBOX_DATA_DIR;
}

function startTestBunServer(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response("ok"),
  });
}

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

describe("isRemoteSession", () => {
  test("false by default (no env vars)", () => {
    clearEnv();
    expect(isRemoteSession()).toBe(false);
  });

  test("true when PLANNOTATOR_REMOTE=1", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    expect(isRemoteSession()).toBe(true);
  });

  test("true when PLANNOTATOR_REMOTE=true", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "true";
    expect(isRemoteSession()).toBe(true);
  });

  test("false when PLANNOTATOR_REMOTE=0", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "0";
    expect(isRemoteSession()).toBe(false);
  });

  test("false when PLANNOTATOR_REMOTE=false", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "false";
    expect(isRemoteSession()).toBe(false);
  });

  test("PLANNOTATOR_REMOTE=false overrides SSH_TTY", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "false";
    process.env.SSH_TTY = "/dev/pts/0";
    expect(isRemoteSession()).toBe(false);
  });

  test("PLANNOTATOR_REMOTE=0 overrides SSH_CONNECTION", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.SSH_CONNECTION = "192.168.1.1 12345 192.168.1.2 22";
    expect(isRemoteSession()).toBe(false);
  });

  test("true when SSH_TTY is set (legacy)", () => {
    clearEnv();
    process.env.SSH_TTY = "/dev/pts/0";
    expect(isRemoteSession()).toBe(true);
  });

  test("true when SSH_CONNECTION is set (legacy)", () => {
    clearEnv();
    process.env.SSH_CONNECTION = "192.168.1.1 12345 192.168.1.2 22";
    expect(isRemoteSession()).toBe(true);
  });
});

describe("isAddressInUseError", () => {
  test("recognizes Bun errors by code", () => {
    expect(isAddressInUseError(Object.assign(new Error("listen failed"), { code: "EADDRINUSE" }))).toBe(true);
  });
});

describe("getServerPort", () => {
  test("PLANNOTATOR_PORT unset preserves the random local default", () => {
    clearEnv();
    expect(getServerPort()).toBe(0);
  });

  test("PLANNOTATOR_PORT unset preserves the 19432 remote default", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    expect(getServerPort()).toBe(19432);
  });

  test("returns 0 when PLANNOTATOR_REMOTE=false overrides SSH", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "false";
    process.env.SSH_TTY = "/dev/pts/0";
    expect(getServerPort()).toBe(0);
  });

  test("explicit PLANNOTATOR_PORT overrides everything", () => {
    clearEnv();
    process.env.PLANNOTATOR_PORT = "8080";
    expect(getServerPort()).toBe(8080);
  });

  test("explicit port overrides remote default", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_PORT = "3000";
    expect(getServerPort()).toBe(3000);
  });

  test("expands an inclusive port range", () => {
    clearEnv();
    process.env.PLANNOTATOR_PORT = "19432-19435";
    expect(getServerPorts()).toEqual([19432, 19433, 19434, 19435]);
    expect(getServerPort()).toBe(19432);
  });

  test("ignores reversed port ranges", () => {
    clearEnv();
    process.env.PLANNOTATOR_PORT = "19435-19432";
    expect(getServerPorts()).toEqual([0]);
  });

  test("ignores ranges containing random port zero", () => {
    clearEnv();
    process.env.PLANNOTATOR_PORT = "0-3";
    expect(getServerPorts()).toEqual([0]);
  });

  test("ignores invalid port (falls back to default)", () => {
    clearEnv();
    process.env.PLANNOTATOR_PORT = "not-a-number";
    expect(getServerPort()).toBe(0);
  });

  test("rejects malformed fixed ports and ranges without accepting numeric prefixes", () => {
    clearEnv();
    for (const value of [
      "19432garbage",
      "19432.5",
      "19432-19435garbage",
      "19432-19435-19436",
    ]) {
      process.env.PLANNOTATOR_PORT = value;
      expect(getServerPorts()).toEqual([0]);
    }
  });

  test("a malformed range follows the existing remote default path", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_PORT = "19432-19435garbage";
    expect(getServerPorts()).toEqual([19432]);
  });

  test("ignores out-of-range port", () => {
    clearEnv();
    process.env.PLANNOTATOR_PORT = "99999";
    expect(getServerPort()).toBe(0);
  });

  test("ignores zero port", () => {
    clearEnv();
    process.env.PLANNOTATOR_PORT = "0";
    expect(getServerPort()).toBe(0);
  });
});

describe("Bun port range binding", () => {
  test("binds the next port when the range start is occupied", async () => {
    clearEnv();
    const { start, servers } = await occupyConsecutivePorts(2);
    await closeServer(servers[1]);
    process.env.PLANNOTATOR_PORT = `${start}-${start + 1}`;

    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      server = await startBunServerOnAvailablePort(startTestBunServer);
      expect(server.port).toBe(start + 1);
    } finally {
      server?.stop(true);
      await closeServer(servers[0]);
    }
  });

  test("reports an exhausted occupied range", async () => {
    clearEnv();
    const { start, servers } = await occupyConsecutivePorts(2);
    process.env.PLANNOTATOR_PORT = `${start}-${start + 1}`;

    try {
      await expect(startBunServerOnAvailablePort(startTestBunServer)).rejects.toThrow(
        new RegExp(`^Port selection ${start}-${start + 1} exhausted$`),
      );
    } finally {
      await Promise.all(servers.map(closeServer));
    }
  });

  test("treats a valid one-port range as range syntax", async () => {
    clearEnv();
    const { start, servers } = await occupyConsecutivePorts(1);
    process.env.PLANNOTATOR_PORT = `${start}-${start}`;

    try {
      await expect(startBunServerOnAvailablePort(startTestBunServer)).rejects.toThrow(
        new RegExp(`^Port selection ${start}-${start} exhausted$`),
      );
    } finally {
      await closeServer(servers[0]);
    }
  });
});

describe("Bun non-range port compatibility", () => {
  test("an occupied fixed port preserves the existing retry error", async () => {
    clearEnv();
    const { start, servers } = await occupyConsecutivePorts(1);
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_PORT = String(start);

    try {
      await expect(startBunServerOnAvailablePort(startTestBunServer)).rejects.toThrow(
        new RegExp(
          `^Port ${start} in use after 5 retries \\(set PLANNOTATOR_PORT to use different port\\)$`,
        ),
      );
    } finally {
      await closeServer(servers[0]);
    }
  });
});

describe("PortInUseError", () => {
  test("a failed fixed-port bind is a PortInUseError the CLI can print as one line", async () => {
    clearEnv();
    const { start, servers } = await occupyConsecutivePorts(1);
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_PORT = String(start);

    try {
      const error = await startBunServerOnAvailablePort(startTestBunServer).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PortInUseError);
      expect((error as PortInUseError).cliMessage).toContain(`port ${start} (PLANNOTATOR_PORT) is already in use`);
      expect((error as PortInUseError).cliMessage).not.toContain("\n");
    } finally {
      await closeServer(servers[0]);
    }
  });

  test("the remote-mode default port names why it is fixed and how to move off it", () => {
    const message = new PortInUseError("Port 19432 in use after 5 retries", 19432, null, false).cliMessage;
    expect(message).toContain("port 19432 is already in use");
    expect(message).toContain("remote mode uses a fixed port");
    expect(message).toContain("PLANNOTATOR_PORT");
  });

  test("an exhausted range names the range", () => {
    const message = new PortInUseError("Port selection 9000-9002 exhausted", 9002, [9000, 9002], true).cliMessage;
    expect(message).toContain("9000-9002");
  });
});

describe("getServerHostname", () => {
  test("returns loopback for local sessions", () => {
    clearEnv();
    expect(getServerHostname()).toBe("127.0.0.1");
  });

  test("returns all interfaces for remote sessions", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    expect(getServerHostname()).toBe("0.0.0.0");
  });
});

describe("buildAdvertisedUrl", () => {
  test("passes the Bun runtime's remote state to the shared URL policy", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_PUBLIC_URL = "https://plannotator.example.com";
    expect(buildAdvertisedUrl(19432)).toBe("https://plannotator.example.com");
  });

  test("defaults to localhost with nothing configured", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_URL_HOST = "";
    expect(buildAdvertisedUrl(19432)).toBe("http://localhost:19432");
  });

  test("a local session ignores the override and advertises localhost", () => {
    clearEnv();
    process.env.PLANNOTATOR_URL_HOST = "my-machine.tailnet.ts.net";
    expect(buildAdvertisedUrl(1234)).toBe("http://localhost:1234");
  });

  test("appends the runtime port to the override host", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_URL_HOST = "my-machine.tailnet.ts.net";
    expect(buildAdvertisedUrl(19432)).toBe("http://my-machine.tailnet.ts.net:19432");
  });

  test("a local session honors a localhost subdomain (#2184), and only that shape", () => {
    clearEnv();
    process.env.PLANNOTATOR_URL_HOST = "plannotator.localhost";
    expect(buildAdvertisedUrl(1234)).toBe("http://plannotator.localhost:1234");
    expect(getLocalUrlHostname()).toBe("plannotator.localhost");
    process.env.PLANNOTATOR_URL_HOST = "a..localhost";
    expect(buildAdvertisedUrl(1234)).toBe("http://localhost:1234");
    expect(getLocalUrlHostname()).toBeUndefined();
    // Still the bind is loopback.
    process.env.PLANNOTATOR_URL_HOST = "plannotator.localhost";
    expect(getServerHostname()).toBe("127.0.0.1");
  });

  test("a remote session treats a localhost subdomain as unset: localhost, no 'open it on your device'", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_URL_HOST = "plannotator.localhost";
    expect(buildAdvertisedUrl(19432)).toBe("http://localhost:19432");
    expect(isLocalOnlyAdvertisedUrl(buildAdvertisedUrl(19432))).toBe(true);
    // A real remote host is still an override.
    process.env.PLANNOTATOR_URL_HOST = "my-machine.tailnet.ts.net";
    expect(isLocalOnlyAdvertisedUrl(buildAdvertisedUrl(19432))).toBe(false);
  });

  test("with nothing configured there is no local name", () => {
    clearEnv();
    process.env.PLANNOTATOR_URL_HOST = "";
    expect(getLocalUrlHostname()).toBeUndefined();
    process.env.PLANNOTATOR_URL_HOST = "my-machine.tailnet.ts.net";
    expect(getLocalUrlHostname()).toBeUndefined();
  });

  test("keeps bracketed IPv6 hosts intact", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_URL_HOST = "[fd7a::1]";
    expect(buildAdvertisedUrl(9999)).toBe("http://[fd7a::1]:9999");
  });

  test("an invalid host falls back to localhost instead of throwing", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_URL_HOST = "https://evil.example/path";
    expect(buildAdvertisedUrl(1234)).toBe("http://localhost:1234");
  });

  test("the override never affects the bind hostname", () => {
    clearEnv();
    process.env.PLANNOTATOR_URL_HOST = "my-machine.tailnet.ts.net";
    expect(getServerHostname()).toBe("127.0.0.1");
    process.env.PLANNOTATOR_REMOTE = "1";
    expect(getServerHostname()).toBe("0.0.0.0");
  });

  test("a reverse-proxy public URL wins over the plannotator.localhost switch (#1266 + #2184)", () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    process.env.PLANNOTATOR_PORT = "19432-19433";
    process.env.PLANNOTATOR_URL_HOST = "plannotator.localhost";
    process.env.PLANNOTATOR_PUBLIC_URL = "https://plannotator.example.com";
    expect(buildAdvertisedUrl(19432)).toBe("https://plannotator.example.com");
    // A later port in the range is not fronted by the proxy; the localhost name
    // still counts as unset remotely, so it falls back to localhost.
    expect(buildAdvertisedUrl(19433)).toBe("http://localhost:19433");
    // A local session ignores the proxy URL and honors the switch.
    delete process.env.PLANNOTATOR_REMOTE;
    delete process.env.PLANNOTATOR_PORT;
    expect(buildAdvertisedUrl(1234)).toBe("http://plannotator.localhost:1234");
  });
});
