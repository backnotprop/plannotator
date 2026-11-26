/**
 * The terminal place seam (inbox-terminal-place.ts, inbox-rex-place.ts) changes nothing for Rex. The failures these
 * guard: a word a person reads about Rex that differs by a byte now that it is made from the place's name, or a word
 * that ignores the name it is given (the next place would read "Rex"); a stored launch record read or written in
 * another shape than `launch.rex` (older records would lose their pane, so Stop would close nothing); Rex's answers
 * reaching the engine changed (here or not and why, the pane it made). Pure: no Rex, no Inbox.
 */
import { describe, expect, test } from "bun:test";
import {
  inboxPlaceMayRun,
  inboxPlaceNoTab,
  inboxPlaceNotHereAgain,
  inboxPlaceRefusedAgain,
  inboxPlaceRunsOpen,
  inboxPlaceServerAway,
  inboxPlaceServerAwayAgain,
  inboxPlaceServerAwaySettings,
  inboxPlaceShared,
  inboxPlaceSharedAgain,
  inboxPlaceStopNoAnswer,
  inboxPlaceStopRefused,
  INBOX_REX_MAY_RUN,
  INBOX_REX_NOT_HERE_AGAIN,
  INBOX_REX_REFUSED_AGAIN,
  INBOX_REX_SERVER_AWAY,
  INBOX_REX_SERVER_AWAY_AGAIN,
  INBOX_REX_SERVER_AWAY_SETTINGS,
  INBOX_REX_SHARED,
  INBOX_REX_SHARED_AGAIN,
  INBOX_RUN_IN_REX_NO_ANSWER,
  INBOX_RUN_IN_REX_NO_TAB,
  INBOX_RUN_IN_REX_OPEN,
  INBOX_RUN_IN_REX_STOP,
} from "@plannotator/core/inbox-run-line";
import { inboxRexPlace } from "./inbox-rex-place";
import { inboxLaunchAsking, inboxLaunchInPlace, inboxLaunchPane, inboxLaunchPlace, inboxLaunchPlaceRecord, inboxStartInPlace, inboxTerminalPlaceName } from "./inbox-terminal-place";

const SESSION = "session:00000000-0000-4000-8000-000000000001";
const BLOCK = "block:00000000-0000-4000-8000-000000000002";

describe("a place's words, for Rex", () => {
  // Each word as its function makes it, its Rex constant, and the exact text it had before the seam.
  const words: [string, (place: string) => string, string, string][] = [
    ["may run", inboxPlaceMayRun, INBOX_REX_MAY_RUN, "It may still be running in Rex. Try again in a minute."],
    ["stop refused", inboxPlaceStopRefused, INBOX_RUN_IN_REX_STOP, "Rex didn't close its tab. Stop it in its tab there."],
    ["stop no answer", inboxPlaceStopNoAnswer, INBOX_RUN_IN_REX_NO_ANSWER, "Rex didn't answer. Stop it in its tab there."],
    ["no tab", inboxPlaceNoTab, INBOX_RUN_IN_REX_NO_TAB, "The Inbox doesn't know its tab in Rex. Stop it in its tab there."],
    ["not here again", inboxPlaceNotHereAgain, INBOX_REX_NOT_HERE_AGAIN, "Rex isn't open on this computer."],
    ["server away again", inboxPlaceServerAwayAgain, INBOX_REX_SERVER_AWAY_AGAIN, "Rex's server isn't running."],
    ["server away", inboxPlaceServerAway, INBOX_REX_SERVER_AWAY, "Rex's server isn't running, so it started in the background."],
    ["server away settings", inboxPlaceServerAwaySettings, INBOX_REX_SERVER_AWAY_SETTINGS, "Rex's server isn't running now, so new agents start in the background until it is."],
    ["shared", inboxPlaceShared, INBOX_REX_SHARED, "Rex here runs as another account, so it started in the background."],
    ["shared again", inboxPlaceSharedAgain, INBOX_REX_SHARED_AGAIN, "Rex here runs as another account."],
    ["refused again", inboxPlaceRefusedAgain, INBOX_REX_REFUSED_AGAIN, "Rex didn't open a tab for it."],
    ["runs, open", inboxPlaceRunsOpen, INBOX_RUN_IN_REX_OPEN, "This agent runs in Rex. Open its tab there."],
  ];
  for (const [label, word, constant, before] of words) {
    test(`${label}: byte for byte what it was, and made from the name it is given`, () => {
      expect(word(inboxTerminalPlaceName("rex"))).toBe(before);
      expect(constant).toBe(before);
      const other = word("Pane Place");
      expect(other).toContain("Pane Place");
      expect(other).not.toContain("Rex");
    });
  }
});

describe("a launch's place, from its stored record", () => {
  test("a Send asking for Rex writes `rex: {}` as before; anything but `rex` asks for none", () => {
    expect(inboxStartInPlace("rex")).toBe("rex");
    expect(inboxStartInPlace("inbox")).toBeNull();
    expect(inboxStartInPlace(undefined)).toBeNull();
    expect(inboxLaunchAsking("rex")).toEqual({ rex: {} });
  });

  test("an older record reads its place, its pane and whether it runs there as `launch.rex` says", () => {
    expect(inboxLaunchPlace({})).toBeNull();
    expect(inboxLaunchPlace({ rex: {} })).toEqual({ kind: "rex", name: "Rex", record: {} });
    expect(inboxLaunchPane({ rex: { line: "Rex · my-app / Claude Code", session: SESSION, block: BLOCK } })).toEqual({ kind: "rex", session: SESSION, block: BLOCK });
    expect(inboxLaunchPane({ rex: { line: "Rex · my-app / Claude Code" } })).toBeNull();
    expect(inboxLaunchInPlace({ rex: { line: "Rex · x" }, session_ref: "s" })).toBe(true);
    expect(inboxLaunchInPlace({ rex: { unavailable: true }, session_ref: "s" })).toBe(false);
    expect(inboxLaunchInPlace({ rex: { refused: true }, session_ref: "s" })).toBe(false);
    expect(inboxLaunchInPlace({ rex: { line: "Rex · x" }, session_ref: null })).toBe(false);
  });

  test("a start's record keeps the shape Stop reads back", () => {
    const pane = { kind: "rex" as const, session: SESSION, block: BLOCK };
    expect(inboxLaunchPlaceRecord("Rex · my-app / Pi", pane)).toEqual({ line: "Rex · my-app / Pi", session: SESSION, block: BLOCK });
    expect(inboxLaunchPlaceRecord("Rex · my-app / Pi", null)).toEqual({ line: "Rex · my-app / Pi" });
    expect(inboxLaunchPane({ rex: inboxLaunchPlaceRecord("Rex · my-app / Pi", pane) })).toEqual(pane);
  });
});

describe("Rex as a place", () => {
  const rex = (attached: boolean, extra: { headless?: boolean; shared?: boolean } = {}) =>
    inboxRexPlace({
      appAttachedNow: async () => attached,
      ...(extra.shared !== undefined ? { shared: () => extra.shared === true } : {}),
      ...(extra.headless ? { headless: true } : {}),
      open: async () => ({ opened: true, session: SESSION, window: "window:1", block: BLOCK, line: "Rex · my-app / Pi" }),
      paneGone: async () => null,
      closePane: async () => "no_answer",
    });

  test("here, or why not: another account's server, a headless server not running, an app not open", async () => {
    expect(await rex(true, { shared: true }).here()).toEqual({ here: true });
    expect(await rex(false, { shared: true, headless: true }).here()).toEqual({ here: false, why: "shared" });
    expect(await rex(false, { headless: true }).here()).toEqual({ here: false, why: "server" });
    expect(await rex(false).here()).toEqual({ here: false, why: "absent" });
    expect(rex(false, { headless: true }).headless).toBe(true);
    expect(rex(false).headless).toBe(false);
  });

  test("a tab Rex made is the agent's pane; a tab it never answered for stays `sent`", async () => {
    expect(await rex(true).open({ project: "my-app", projectKey: "p", tab: "Pi", command: "true" })).toEqual({ opened: true, line: "Rex · my-app / Pi", pane: { kind: "rex", session: SESSION, block: BLOCK } });
    const noBlock = inboxRexPlace({ appAttachedNow: async () => true, open: async () => ({ opened: true, session: SESSION, window: "w", block: null, line: "Rex" }), paneGone: async () => null, closePane: async () => "gone" });
    expect(await noBlock.open({ project: "p", projectKey: "p", tab: "t", command: "true" })).toEqual({ opened: true, line: "Rex", pane: null });
    const sent = inboxRexPlace({ appAttachedNow: async () => true, open: async () => ({ opened: false, sent: true }), paneGone: async () => null, closePane: async () => "gone" });
    expect(await sent.open({ project: "p", projectKey: "p", tab: "t", command: "true" })).toEqual({ opened: false, sent: true });
  });
});
