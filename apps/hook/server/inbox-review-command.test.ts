/**
 * `plannotator inbox --review` (inbox-review-command.ts) over stand-in deps: no Inbox starts, no browser opens.
 *
 * What regresses: a first run starting the Inbox (or turning it on) before code review only and the welcome are saved,
 * so an agent session could begin with the full Inbox's words; an existing full-Inbox person switched to code review
 * only without asking; Code review left off for them; the window not shown Reviews; the URL not printed; a save that
 * failed reported as done; a first-run save that landed in part (config.json written, state.json not) leaving the mode
 * on with no welcome while it says nothing changed.
 */
import { describe, expect, test } from "bun:test";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { REVIEW_CODE_REVIEW_ON, REVIEW_NOT_TURNED_ON, runInboxReviewCommand, type InboxReviewDeps } from "./inbox-review-command";

const ENTRY = { url: "http://127.0.0.1:41234/", port: 41234, token: "tok" };

function world(options: { firstRun: boolean; config?: PlannotatorConfig; running?: boolean; window?: boolean; saves?: boolean; marks?: boolean }) {
  let config: PlannotatorConfig = structuredClone(options.config ?? {});
  const log: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const posts: { url: string; body: unknown; auth: string | null }[] = [];
  const deps: InboxReviewDeps<typeof ENTRY> = {
    firstRun: options.firstRun,
    markOn: () => {
      log.push(`markOn ${JSON.stringify(config)}`);
      return options.marks !== false;
    },
    load: () => structuredClone(config),
    save: (patch) => {
      log.push(`save ${JSON.stringify(patch)}`);
      if (options.saves !== false) config = { ...config, ...patch };
    },
    runningInbox: async () => (options.running ? { url: ENTRY.url } : null),
    ensureInbox: async () => {
      log.push(`ensureInbox ${JSON.stringify(config)}`);
      return ENTRY;
    },
    openUrl: async (url) => void log.push(`open ${url}`),
    connect: async () => void log.push("connect"),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "null"));
      posts.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/api/inbox/settings")) {
        config = { ...config, inboxCodeReview: true };
        return Response.json({ code_review: { on: true } });
      }
      return Response.json({ shown: options.window === true });
    }) as typeof fetch,
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    now: () => new Date("2026-11-25T10:00:00.000Z"),
  };
  return { deps, log, out, err, posts, config: () => config };
}

describe("a first run (the Inbox was never on here)", () => {
  test("code review only, Code review on and the welcome saved before the Inbox is turned on or started; then Reviews opens and agents are connected", async () => {
    const w = world({ firstRun: true });
    expect(await runInboxReviewCommand(w.deps)).toBe(0);
    // Code review's flip stamped too, so a linked computer's older flip never turns it back.
    const at = Date.parse("2026-11-25T10:00:00.000Z");
    expect(w.log.slice(0, 2)).toEqual([
      `save ${JSON.stringify({ inboxReviewWelcome: { dueAt: "2026-11-25T10:00:00.000Z" } })}`,
      `save ${JSON.stringify({ inboxCodeReview: true, inboxReviewOnly: true, inboxCapabilityFlips: { code_review: { at, by: null } } })}`,
    ]);
    // Turned on and started only after: both see code review only.
    expect(w.log[2]).toStartWith("markOn ");
    expect(JSON.parse(w.log[2]!.slice("markOn ".length))).toMatchObject({ inboxCodeReview: true, inboxReviewOnly: true });
    expect(JSON.parse(w.log[3]!.slice("ensureInbox ".length))).toMatchObject({ inboxReviewOnly: true });
    expect(w.log.slice(4)).toEqual([`open ${ENTRY.url}#reviews`, "connect"]);
    expect(w.out).toEqual([`${ENTRY.url}#reviews`]);
    expect(w.err).toEqual([REVIEW_CODE_REVIEW_ON]);
  });

  test("a config.json that cannot be saved: nothing turned on or started, and it says so", async () => {
    const w = world({ firstRun: true, saves: false });
    expect(await runInboxReviewCommand(w.deps)).toBe(1);
    expect(w.log.filter((line) => !line.startsWith("save "))).toEqual([]);
    expect(w.err[0]).toStartWith("config_not_saved:");
    expect(w.out).toEqual([]);
  });

  /** saveConfig's split (packages/shared/config.ts): the welcome to state.json, the rest to config.json; either file may fail on its own. */
  function splitFiles(fails: "state" | "config") {
    const w = world({ firstRun: true, config: { inboxBoard: true } });
    const files = { state: {} as PlannotatorConfig, config: { inboxBoard: true } as PlannotatorConfig };
    w.deps.load = () => ({ ...structuredClone(files.config), ...structuredClone(files.state) });
    w.deps.save = (patch) => {
      const { inboxReviewWelcome, ...rest } = patch;
      // As saveConfig: state.json first, then config.json whatever state.json did.
      if ("inboxReviewWelcome" in patch && fails !== "state") files.state = { ...files.state, inboxReviewWelcome };
      if (Object.keys(rest).length > 0 && fails !== "config") files.config = { ...files.config, ...rest };
    };
    return { w, files };
  }

  for (const fails of ["state", "config"] as const) {
    test(`a first-run save where ${fails === "state" ? "state.json" : "config.json"} alone cannot be written: the computer is left exactly as it was, and it says so`, async () => {
      const { w, files } = splitFiles(fails);
      expect(await runInboxReviewCommand(w.deps)).toBe(1);
      expect(files.config).toEqual({ inboxBoard: true });
      expect(files.state.inboxReviewWelcome).toBeUndefined();
      expect(w.deps.load()).toEqual({ inboxBoard: true });
      expect(w.err[0]).toStartWith("config_not_saved:");
      expect(w.log.some((line) => line.startsWith("markOn") || line.startsWith("ensureInbox"))).toBe(false);
    });
  }

  test("the Inbox's mark cannot be written: nothing started, and it says so", async () => {
    const w = world({ firstRun: true, marks: false });
    expect(await runInboxReviewCommand(w.deps)).toBe(1);
    expect(w.log.some((line) => line.startsWith("ensureInbox"))).toBe(false);
    expect(w.err).toEqual([REVIEW_NOT_TURNED_ON]);
    expect(w.out).toEqual([]);
  });

  test("the welcome's due time not read back as saved: nothing turned on or started", async () => {
    const w = world({ firstRun: true });
    const save = w.deps.save;
    w.deps.save = (patch) => save({ ...patch, inboxReviewWelcome: undefined });
    expect(await runInboxReviewCommand(w.deps)).toBe(1);
    expect(w.log.some((line) => line.startsWith("markOn") || line.startsWith("ensureInbox"))).toBe(false);
  });

  test("someone who chose code review only, switched back to the full Inbox and later turned the Inbox off: not put back", async () => {
    const w = world({ firstRun: true, config: { inboxCodeReview: true, inboxReviewOnly: false } });
    expect(await runInboxReviewCommand(w.deps)).toBe(0);
    expect(w.config().inboxReviewOnly).toBe(false);
    expect(w.config().inboxReviewWelcome).toBeUndefined();
    // Turned on again, as a plain `plannotator inbox` would; nothing said, Code review was on.
    expect(w.log.some((line) => line.startsWith("markOn"))).toBe(true);
    expect(w.err).toEqual([]);
  });
});

describe("someone who already uses the Inbox", () => {
  test("the full Inbox stays the full Inbox: only Code review turns on, through the running Inbox; nothing else is saved", async () => {
    const w = world({ firstRun: false, config: { inboxBoard: true }, running: true, window: true });
    expect(await runInboxReviewCommand(w.deps)).toBe(0);
    expect(w.config().inboxReviewOnly).toBeUndefined();
    expect(w.config().inboxReviewWelcome).toBeUndefined();
    expect(w.config().inboxCodeReview).toBe(true);
    expect(w.log.filter((line) => line.startsWith("save ") || line.startsWith("markOn") || line === "connect")).toEqual([]);
    expect(w.posts[0]).toMatchObject({ url: `${ENTRY.url}api/inbox/settings`, body: { code_review: { on: true } } });
    // The open window goes to Reviews; no new tab.
    expect(w.posts[1]).toMatchObject({ url: `${ENTRY.url}api/inbox/control/show`, body: { page: "reviews" }, auth: "Bearer tok" });
    expect(w.log.some((line) => line.startsWith("open "))).toBe(false);
    expect(w.out).toEqual([`${ENTRY.url}#reviews`]);
    expect(w.err).toEqual([REVIEW_CODE_REVIEW_ON]);
  });

  test("Code review already on, no window open: no line, nothing saved, a new tab on Reviews", async () => {
    const w = world({ firstRun: false, config: { inboxCodeReview: true } });
    expect(await runInboxReviewCommand(w.deps)).toBe(0);
    expect(w.err).toEqual([]);
    expect(w.log.filter((line) => line.startsWith("save "))).toEqual([]);
    expect(w.log.at(-1)).toBe(`open ${ENTRY.url}#reviews`);
  });

  test("a code-review-only person who switched back to the full Inbox is not switched again", async () => {
    const w = world({ firstRun: false, config: { inboxCodeReview: true, inboxReviewOnly: false } });
    await runInboxReviewCommand(w.deps);
    expect(w.config().inboxReviewOnly).toBe(false);
  });

  test("no Inbox running: Code review on through config.json", async () => {
    const w = world({ firstRun: false });
    expect(await runInboxReviewCommand(w.deps)).toBe(0);
    expect(w.log[0]).toBe(`save ${JSON.stringify({ inboxCodeReview: true, inboxCapabilityFlips: { code_review: { at: Date.parse("2026-11-25T10:00:00.000Z"), by: null } } })}`);
    expect(w.config().inboxReviewOnly).toBeUndefined();
  });
});
