import { expect, test } from "bun:test";
import { INBOX_AUTO_SEND_AFTER_MS } from "@plannotator/core/inbox-types";
import { autoSendAfterMsFromEnv } from "./inbox-command";

test("a release ignores the knob unless the test sandbox is set", () => {
  expect(autoSendAfterMsFromEnv({ PLANNOTATOR_INBOX_AUTO_SEND_MS: "1000" }, "0.28.25")).toEqual({});
  expect(autoSendAfterMsFromEnv({ PLANNOTATOR_INBOX_AUTO_SEND_MS: "1000", PLANNOTATOR_TEST_SANDBOX: "/tmp/x" }, "0.28.25")).toEqual({ autoSendAfterMs: 1000 });
});

test("a build that is not a release honours it, only to shorten the wait, never under a second", () => {
  for (const version of ["0.0.0-dev", undefined]) {
    expect(autoSendAfterMsFromEnv({ PLANNOTATOR_INBOX_AUTO_SEND_MS: "2000" }, version)).toEqual({ autoSendAfterMs: 2000 });
    expect(autoSendAfterMsFromEnv({ PLANNOTATOR_INBOX_AUTO_SEND_MS: "999" }, version)).toEqual({});
    expect(autoSendAfterMsFromEnv({ PLANNOTATOR_INBOX_AUTO_SEND_MS: String(INBOX_AUTO_SEND_AFTER_MS + 1) }, version)).toEqual({});
    expect(autoSendAfterMsFromEnv({ PLANNOTATOR_INBOX_AUTO_SEND_MS: "1e4" }, version)).toEqual({});
  }
});
