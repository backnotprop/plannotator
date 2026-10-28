/**
 * PLANNOTATOR_LIVE_PORT: reading the variable and the port loop both live
 * proxy transports share (packages/server/live-proxy.ts for Bun,
 * packages/shared/live-proxy-node.ts for Node/Pi). The transports' own tests
 * bind real ports; this file pins the decisions with errors made by hand, so
 * EACCES is covered on machines where a low port would bind anyway.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  createLiveProxyPortAttempts,
  getLiveProxyPortSelection,
  LiveProxyPortError,
  LiveProxyPortInUseError,
} from "./live-proxy-port";

function listenError(code: string): Error {
  return Object.assign(new Error(`listen ${code}: 127.0.0.1`), { code });
}

describe("getLiveProxyPortSelection", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.PLANNOTATOR_LIVE_PORT;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PLANNOTATOR_LIVE_PORT;
    else process.env.PLANNOTATOR_LIVE_PORT = saved;
  });

  test("unset is a random port", () => {
    delete process.env.PLANNOTATOR_LIVE_PORT;
    expect(getLiveProxyPortSelection()).toEqual({ kind: "fixed", ports: [0] });
  });

  test("a fixed port and a range are read", () => {
    process.env.PLANNOTATOR_LIVE_PORT = "19440";
    expect(getLiveProxyPortSelection()).toEqual({ kind: "fixed", ports: [19440] });
    process.env.PLANNOTATOR_LIVE_PORT = "19440-19442";
    expect(getLiveProxyPortSelection()).toEqual({ kind: "range", ports: [19440, 19441, 19442] });
  });

  test("an invalid value warns and falls back to a random port", () => {
    const warn = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const value of ["abc", "70000", "19442-19440", "0-5", "19440-"]) {
        process.env.PLANNOTATOR_LIVE_PORT = value;
        expect(getLiveProxyPortSelection()).toEqual({ kind: "fixed", ports: [0] });
        expect(warn).toHaveBeenLastCalledWith(
          `[Plannotator] Warning: Invalid PLANNOTATOR_LIVE_PORT "${value}", using default`,
        );
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createLiveProxyPortAttempts", () => {
  test("a range moves past busy and denied ports", () => {
    const attempts = createLiveProxyPortAttempts({ kind: "range", ports: [80, 19440, 19441] });
    expect(() => attempts.failed(80, listenError("EACCES"))).not.toThrow();
    expect(() => attempts.failed(19440, listenError("EADDRINUSE"))).not.toThrow();
  });

  test("every port busy is the in-use error, worded as before", () => {
    const fixed = createLiveProxyPortAttempts({ kind: "fixed", ports: [19440] });
    fixed.failed(19440, listenError("EADDRINUSE"));
    const fixedError = fixed.exhausted();
    expect(fixedError).toBeInstanceOf(LiveProxyPortInUseError);
    expect(fixedError.message).toBe(
      "Plannotator: live app proxy port 19440 (PLANNOTATOR_LIVE_PORT) is already in use. Close another live annotation session or set PLANNOTATOR_LIVE_PORT to a different port or range.",
    );

    const range = createLiveProxyPortAttempts({ kind: "range", ports: [19440, 19441] });
    range.failed(19440, listenError("EADDRINUSE"));
    range.failed(19441, new Error("Failed to start server. Is port 19441 in use? EADDRINUSE"));
    expect(range.exhausted().message).toContain("every port in PLANNOTATOR_LIVE_PORT 19440-19441 is already in use");
  });

  test("a fixed port that may not be bound says so in one line", () => {
    const attempts = createLiveProxyPortAttempts({ kind: "fixed", ports: [80] });
    attempts.failed(80, listenError("EACCES"));
    const error = attempts.exhausted();
    expect(error).toBeInstanceOf(LiveProxyPortError);
    expect(error).not.toBeInstanceOf(LiveProxyPortInUseError);
    expect(error.message).toBe(
      "Plannotator: live app proxy port 80 (PLANNOTATOR_LIVE_PORT) could not be used (EACCES: permission denied). Ports below 1024 usually need root. Set PLANNOTATOR_LIVE_PORT to a different port or range.",
    );
    expect(error.message).not.toContain("\n");
  });

  test("a range that ran out on mixed failures names what happened", () => {
    const attempts = createLiveProxyPortAttempts({ kind: "range", ports: [1022, 1023, 1024] });
    attempts.failed(1022, listenError("EACCES"));
    attempts.failed(1023, listenError("EACCES"));
    attempts.failed(1024, listenError("EADDRINUSE"));
    const error = attempts.exhausted();
    expect(error).not.toBeInstanceOf(LiveProxyPortInUseError);
    expect(error.message).toBe(
      "Plannotator: live app proxy could not use any port in PLANNOTATOR_LIVE_PORT 1022-1024 (2 permission denied (EACCES), 1 in use). Ports below 1024 usually need root. Set PLANNOTATOR_LIVE_PORT to a different port or range.",
    );
  });

  test("any other code stops the loop with one clear line", () => {
    const attempts = createLiveProxyPortAttempts({ kind: "range", ports: [19440, 19441] });
    let thrown: unknown;
    try {
      attempts.failed(19440, listenError("EADDRNOTAVAIL"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LiveProxyPortError);
    expect((thrown as Error).message).toBe(
      "Plannotator: live app proxy port 19440 (PLANNOTATOR_LIVE_PORT) could not be used (EADDRNOTAVAIL: address not available). Set PLANNOTATOR_LIVE_PORT to a different port or range.",
    );
  });

  test("an error with no code is rethrown as it is", () => {
    const attempts = createLiveProxyPortAttempts({ kind: "fixed", ports: [0] });
    const bug = new TypeError("not a port problem");
    expect(() => attempts.failed(0, bug)).toThrow(bug);
  });
});
