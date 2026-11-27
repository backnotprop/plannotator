/**
 * The Inbox for code review only (inbox-review-only.ts) and the notes' one queue (inbox-review-only-notes.ts), over a
 * stand-in config.json, with the real notes in a scratch agent home (tests/helpers/fake-agents.ts; the real home is
 * never touched). No Inbox runs.
 *
 * What regresses:
 *  - the notes: a note left in a file while code review only, or the person's own text around it touched; a removal
 *    that fails for one agent never tried again (the pass "done" because a list exists); the list of notes to put back
 *    saved after an agent's record went, or a failed save of it still letting the pass change files; a note lost on
 *    the way back (a failed add never tried again); the automatic add writing a note after code review only began
 *    (two writers racing); a concurrent edit (a Gemini memory saved) lost to a removal; a write while
 *    PLANNOTATOR_INBOX_NOTES=0; a second, marked note beside one pasted by hand; the person's own switch during the
 *    mode not followed on the way back; an edited section lost instead of put back as they left it (also in a file
 *    two agents share, whichever agent comes first, and with two edited files for one agent, each back where it came
 *    from); a file left read-only retried every minute forever instead of less and less often.
 *  - the switch: code review only needing a second switch (Code review) to hold, or switching back leaving Code
 *    review off; the Settings row's `chosen` lost; the welcome open outside the mode.
 *  - linked computers: the mode, or Code review while in it, given to or taken from a linked computer; a linked
 *    computer's flip of Code review made while in the mode turning it off here after the switch back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { INBOX_CAPABILITY_AGENT_IDS, INBOX_CAPABILITY_SET_KEYS, INBOX_CAPABILITY_SWITCH_KEYS, type InboxCapabilitySetKey, type InboxNoteAgentId } from "@plannotator/core/inbox-types";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { addInboxNote, INBOX_NOTE_BLOCK, noteStatus, noteTarget, removeInboxNote } from "./inbox-agent-notes";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { createCapabilitySet } from "./inbox-capability-set";
import { createReviewOnly, reviewOnlyShares } from "./inbox-review-only";
import { createAgentNotes, RETRY_MAX_MS } from "./inbox-review-only-notes";

let fake: FakeAgents;
let dataDir: string;
let e: AgentEnvironment;

beforeEach(() => {
  fake = createFakeAgents("plannotator-review-only-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  e = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env });
});
afterEach(() => {
  // Writable again, so the scratch folder can go.
  for (const path of written) if (existsSync(path)) chmodSync(path, 0o644);
  written.length = 0;
  fake.remove();
});

const written: string[] = [];
const MINE_BEFORE = "# My rules\n\nAlways run the tests.\n";
const MINE_AFTER = "\n## Later\n\nKeep commits small.\n";
const read = (path: string) => readFileSync(path, "utf8");
const AGENTS = ["gemini", "qwen", "pi"] as const;

/** Gemini, Qwen Code and Pi, each with the person's own rules file and the Inbox note in it. */
function withNotes(): Record<(typeof AGENTS)[number], string> {
  fake.install(...AGENTS);
  mkdirSync(join(fake.home, ".gemini"), { recursive: true });
  mkdirSync(join(fake.home, ".qwen"), { recursive: true });
  mkdirSync(join(fake.home, ".pi", "agent"), { recursive: true });
  const out = {} as Record<(typeof AGENTS)[number], string>;
  for (const id of AGENTS) {
    const path = noteTarget(id, e).path!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, MINE_BEFORE);
    written.push(path);
    expect(addInboxNote(id, dataDir, e)).toMatchObject({ ok: true });
    out[id] = path;
  }
  return out;
}

/** One computer: config.json in memory, the real notes in the scratch home, the notes' queue and the switch. */
function computer(start: PlannotatorConfig = {}, options: { env?: Record<string, string>; timer?: (run: () => void, ms: number) => { cancel: () => void } } = {}) {
  let config: PlannotatorConfig = structuredClone(start);
  const said = { changed: 0, auto: 0, asked: [] as string[] };
  /** A save that does not land (config.json unwritable): the notes' list is dropped. */
  let failing = false;
  const save = (patch: Partial<PlannotatorConfig>) => {
    if (failing && "inboxReviewOnlyNotes" in patch) return;
    config = { ...config, ...structuredClone(patch) };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (config as Record<string, unknown>)[key];
  };
  let autoAdd: (mayWrite: () => boolean) => Promise<unknown> = async () => void said.auto++;
  const environment = options.env ? createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...options.env } }) : e;
  const notes = createAgentNotes({
    dataDir,
    environment,
    reviewOnly: () => config.inboxReviewOnly === true,
    load: () => structuredClone(config),
    save,
    markAsked: async (ids) => void said.asked.push(...ids),
    autoAdd: (mayWrite) => autoAdd(mayWrite),
    stopped: () => false,
    retryMs: options.timer ? 60_000 : 60 * 60_000,
    ...(options.timer ? { timer: options.timer } : {}),
  });
  const reviewOnly = createReviewOnly({
    load: () => structuredClone(config),
    save,
    syncNotes: async () => {
      await notes.sync();
      await notes.auto();
    },
    changed: () => void said.changed++,
  });
  return {
    notes,
    reviewOnly,
    said,
    config: () => config,
    set: save,
    failSaves: (on: boolean) => void (failing = on),
    onAuto: (run: (mayWrite: () => boolean) => Promise<unknown>) => void (autoAdd = run),
  };
}

describe("the notes, out with code review only and back with the full Inbox", () => {
  test("out of every file, only their own section; back the same way; the list goes once all are back", async () => {
    const files = withNotes();
    writeFileSync(files.gemini, read(files.gemini) + MINE_AFTER);
    const one = computer({ inboxCodeReview: true });
    expect(await one.reviewOnly.save({ on: false })).toEqual({ on: false, chosen: true });
    expect(read(files.gemini)).toBe(`${MINE_BEFORE}${MINE_AFTER}`);
    for (const id of ["qwen", "pi"] as const) expect(read(files[id])).toBe(MINE_BEFORE);
    expect(one.config().inboxReviewOnlyNotes).toMatchObject({ for: "review_only", out: [] });
    expect([...one.config().inboxReviewOnlyNotes!.back].sort()).toEqual([...AGENTS].sort());
    // Counted as asked, so the automatic add never writes one of them by itself; and it did not run.
    expect([...one.said.asked].sort()).toEqual([...AGENTS].sort());
    expect(one.said.auto).toBe(0);

    expect(await one.reviewOnly.save({ on: true })).toEqual({ on: true, chosen: true });
    expect(one.config()).toMatchObject({ inboxReviewOnly: false, inboxCodeReview: true });
    expect(one.config().inboxReviewOnlyNotes).toBeUndefined();
    for (const id of AGENTS) expect(read(files[id]).startsWith(MINE_BEFORE) && read(files[id]).includes(INBOX_NOTE_BLOCK)).toBe(true);
    expect(read(files.gemini)).toContain(MINE_AFTER);
    // Then what a full Inbox writes by itself.
    expect(one.said.auto).toBe(1);
  });

  test("the second of three fails: the others come out, it stays on the list, and the next pass takes it out", async () => {
    const files = withNotes();
    chmodSync(files.qwen, 0o444);
    const one = computer({ inboxCodeReview: true });
    await one.reviewOnly.save({ on: false });
    expect(read(files.gemini)).toBe(MINE_BEFORE);
    expect(read(files.pi)).toBe(MINE_BEFORE);
    expect(read(files.qwen)).toContain(INBOX_NOTE_BLOCK);
    expect(one.config().inboxReviewOnlyNotes?.out).toEqual(["qwen"]);
    // Never "done" because a list exists: every pass (a start, a flip, the timer) tries it again.
    await one.notes.sync();
    expect(read(files.qwen)).toContain(INBOX_NOTE_BLOCK);
    chmodSync(files.qwen, 0o644);
    await one.notes.sync();
    expect(read(files.qwen)).toBe(MINE_BEFORE);
    expect(one.config().inboxReviewOnlyNotes?.out).toEqual([]);
    // And back, all three, the one that failed included.
    await one.reviewOnly.save({ on: true });
    for (const id of AGENTS) expect(read(files[id])).toContain(INBOX_NOTE_BLOCK);
    expect(one.config().inboxReviewOnlyNotes).toBeUndefined();
  });

  test("the list's save fails: no file and no record changes; the next pass, once it saves, takes them out", async () => {
    const files = withNotes();
    const one = computer({ inboxCodeReview: true });
    one.failSaves(true);
    await one.reviewOnly.save({ on: false });
    for (const id of AGENTS) {
      expect(read(files[id])).toContain(INBOX_NOTE_BLOCK);
      expect(noteStatus(id, dataDir, e).state).toBe("added");
    }
    one.failSaves(false);
    await one.notes.sync();
    for (const id of AGENTS) expect(read(files[id])).toBe(MINE_BEFORE);
    await one.reviewOnly.save({ on: true });
    for (const id of AGENTS) expect(read(files[id])).toContain(INBOX_NOTE_BLOCK);
  });

  test("a put-back that fails stays on the list and is tried again: no note is ever lost", async () => {
    const files = withNotes();
    const one = computer({ inboxCodeReview: true });
    await one.reviewOnly.save({ on: false });
    chmodSync(files.pi, 0o444);
    await one.reviewOnly.save({ on: true });
    expect(read(files.pi)).toBe(MINE_BEFORE);
    expect(one.config().inboxReviewOnlyNotes).toMatchObject({ for: "full", back: ["pi"] });
    chmodSync(files.pi, 0o644);
    await one.notes.sync();
    expect(read(files.pi)).toContain(INBOX_NOTE_BLOCK);
    expect(one.config().inboxReviewOnlyNotes).toBeUndefined();
  });

  test("a section the person edited comes out once its text is saved, and goes back exactly as they left it", async () => {
    const files = withNotes();
    writeFileSync(files.gemini, read(files.gemini).replace("## Plannotator Inbox", "## Plannotator Inbox (mine now)"));
    const edited = read(files.gemini);
    expect(noteStatus("gemini", dataDir, e).state).toBe("edited");
    const one = computer({ inboxCodeReview: true });
    await one.reviewOnly.save({ on: false });
    expect(read(files.gemini)).toBe(MINE_BEFORE);
    expect(one.config().inboxReviewOnlyNotes?.edited?.[realpathSync(files.gemini)]).toContain("## Plannotator Inbox (mine now)");
    await one.reviewOnly.save({ on: true });
    expect(read(files.gemini)).toBe(edited);
    expect(noteStatus("gemini", dataDir, e).state).toBe("edited");
  });

  /**
   * Codex and Pi reading one real file: Pi's AGENTS.md a link to Codex's (`link`), or both homes the same folder (the
   * same path). `piFirst`: Pi is put back first (a switch back that had not finished for Pi listed it first).
   */
  function sharedFile(how: "link" | "same path") {
    fake.install("codex", "pi");
    const codexHome = join(fake.home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const real = join(codexHome, "AGENTS.md");
    writeFileSync(real, MINE_BEFORE);
    written.push(real);
    const env = how === "same path" ? { PI_CODING_AGENT_DIR: codexHome } : undefined;
    const here = env ? createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...env } }) : e;
    if (how === "link") {
      mkdirSync(join(fake.home, ".pi", "agent"), { recursive: true });
      symlinkSync(real, join(fake.home, ".pi", "agent", "AGENTS.md"));
    }
    expect(addInboxNote("codex", dataDir, here)).toMatchObject({ ok: true, action: "added" });
    expect(addInboxNote("pi", dataDir, here)).toMatchObject({ ok: true, action: "shared" });
    return { real, env, here };
  }

  for (const how of ["link", "same path"] as const) {
    for (const piFirst of [false, true]) {
      const order = piFirst ? "Pi put back first" : "Codex put back first";
      test(`one file two agents share (${how}), edited: it goes back exactly as the person left it, ${order}; both agents have it again`, async () => {
        const { real, env, here } = sharedFile(how);
        writeFileSync(real, read(real).replace("## Plannotator Inbox", "## Plannotator Inbox (ours)"));
        const edited = read(real);
        for (const id of ["codex", "pi"] as const) expect(noteStatus(id, dataDir, here).state).toBe("edited");
        const one = computer({ inboxCodeReview: true, ...(piFirst ? { inboxReviewOnlyNotes: { for: "full", back: ["pi"], out: [] } } : {}) }, env ? { env } : {});
        await one.reviewOnly.save({ on: false });
        expect(read(real)).toBe(MINE_BEFORE);
        expect(one.config().inboxReviewOnlyNotes?.back).toEqual(piFirst ? ["pi", "codex"] : ["codex", "pi"]);
        await one.reviewOnly.save({ on: true });
        expect(read(real)).toBe(edited);
        for (const id of ["codex", "pi"] as const) expect(noteStatus(id, dataDir, here).state).toBe("edited");
        expect(one.config().inboxReviewOnlyNotes).toBeUndefined();
      });
    }
    for (const piFirst of [false, true]) {
      test(`one file two agents share (${how}), not edited: Plannotator's note goes back once, ${piFirst ? "Pi" : "Codex"} put back first`, async () => {
        const { real, env, here } = sharedFile(how);
        const one = computer({ inboxCodeReview: true, ...(piFirst ? { inboxReviewOnlyNotes: { for: "full", back: ["pi"], out: [] } } : {}) }, env ? { env } : {});
        await one.reviewOnly.save({ on: false });
        expect(read(real)).toBe(MINE_BEFORE);
        await one.reviewOnly.save({ on: true });
        expect(read(real).split(INBOX_NOTE_BLOCK).length).toBe(2);
        expect(read(real).startsWith(MINE_BEFORE)).toBe(true);
        for (const id of ["codex", "pi"] as const) expect(noteStatus(id, dataDir, here).state).toBe("added");
      });
    }
  }

  test("one agent with two files that both hold an edited section (AGENTS.md and AGENTS.override.md): each goes back into its own file", async () => {
    fake.install("codex");
    const codexHome = join(fake.home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const main = join(codexHome, "AGENTS.md");
    const override = join(codexHome, "AGENTS.override.md");
    writeFileSync(main, MINE_BEFORE);
    written.push(main, override);
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, path: "~/.codex/AGENTS.md" });
    writeFileSync(override, "# Override\n");
    expect(addInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, path: "~/.codex/AGENTS.override.md" });
    writeFileSync(main, read(main).replace("## Plannotator Inbox", "## Plannotator Inbox (main)"));
    writeFileSync(override, read(override).replace("## Plannotator Inbox", "## Plannotator Inbox (override)"));
    const mainEdited = read(main);
    const overrideEdited = read(override);
    const one = computer({ inboxCodeReview: true });
    await one.reviewOnly.save({ on: false });
    expect([read(main), read(override)]).toEqual([MINE_BEFORE, "# Override\n"]);
    await one.reviewOnly.save({ on: true });
    expect([read(main), read(override)]).toEqual([mainEdited, overrideEdited]);
    expect(one.config().inboxReviewOnlyNotes).toBeUndefined();
  });

  test("a file left read-only: tried again less and less often, up to an hour, with nothing logged; at once again once it matches", async () => {
    const files = withNotes();
    chmodSync(files.qwen, 0o444);
    const waits: number[] = [];
    let pending: (() => void) | null = null;
    const one = computer({ inboxCodeReview: true }, { timer: (run, ms) => (waits.push(ms), (pending = run), { cancel: () => void (pending = null) }) });
    const said: unknown[] = [];
    const saved = { error: console.error, warn: console.warn, log: console.log, write: process.stderr.write };
    console.error = console.warn = console.log = (...args: unknown[]) => void said.push(args);
    process.stderr.write = ((chunk: unknown) => (said.push(chunk), true)) as typeof process.stderr.write;
    try {
      await one.reviewOnly.save({ on: false });
      for (let i = 0; i < 8; i++) {
        const run = pending as (() => void) | null;
        pending = null;
        run?.();
        await one.notes.idle();
      }
    } finally {
      Object.assign(console, { error: saved.error, warn: saved.warn, log: saved.log });
      process.stderr.write = saved.write;
    }
    expect(waits).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS]);
    expect(said).toEqual([]);
    expect(read(files.qwen)).toContain(INBOX_NOTE_BLOCK);
    chmodSync(files.qwen, 0o644);
    (pending as (() => void) | null)?.();
    await one.notes.idle();
    expect(read(files.qwen)).toBe(MINE_BEFORE);
    expect(waits.length).toBe(9);
    // Something left again later (the put-back, the same file read-only again): a minute first, as before.
    chmodSync(files.qwen, 0o444);
    await one.reviewOnly.save({ on: true });
    expect(waits.slice(9)).toEqual([60_000]);
  });

  test("the person's own switch while code review only: the list follows, so switching back gives what they last chose", async () => {
    const files = withNotes();
    const one = computer({ inboxCodeReview: true });
    await one.reviewOnly.save({ on: false });
    // Gemini's note on again, by hand in Settings → Agents; Qwen's turned off (it is out already).
    expect(await one.notes.person("gemini", () => addInboxNote("gemini", dataDir, e))).toMatchObject({ ok: true });
    expect(await one.notes.person("qwen", () => removeInboxNote("qwen", dataDir, e))).toMatchObject({ ok: true });
    // The next pass leaves Gemini's in.
    await one.notes.sync();
    expect(read(files.gemini)).toContain(INBOX_NOTE_BLOCK);
    await one.reviewOnly.save({ on: true });
    expect(read(files.gemini)).toContain(INBOX_NOTE_BLOCK);
    expect(read(files.qwen)).toBe(MINE_BEFORE);
    expect(read(files.pi)).toContain(INBOX_NOTE_BLOCK);
  });

  test("PLANNOTATOR_INBOX_NOTES=0: nothing is written, either way", async () => {
    const files = withNotes();
    const one = computer({ inboxCodeReview: true }, { env: { PLANNOTATOR_INBOX_NOTES: "0" } });
    await one.reviewOnly.save({ on: false });
    for (const id of AGENTS) expect(read(files[id])).toContain(INBOX_NOTE_BLOCK);
    expect(one.config().inboxReviewOnlyNotes).toBeUndefined();
  });

  test("back where the person pasted the note by hand without markers: no second, marked copy", async () => {
    const files = withNotes();
    const one = computer({ inboxCodeReview: true });
    await one.reviewOnly.save({ on: false });
    const pasted = `${MINE_BEFORE}\n## Plannotator Inbox\n\nThe person keeps a Plannotator Inbox here.\n`;
    writeFileSync(files.gemini, pasted);
    await one.reviewOnly.save({ on: true });
    expect(read(files.gemini)).toBe(pasted);
    expect(one.config().inboxReviewOnlyNotes).toBeUndefined();
  });

  test("a removal never loses a concurrent edit (a Gemini memory saved meanwhile): it is not written, and tried again", () => {
    const files = withNotes();
    const memory = "\n## Gemini Added Memories\n- the person likes small commits\n";
    const change = removeInboxNote("gemini", dataDir, e, undefined, { auto: true, beforeWrite: (target) => writeFileSync(target, read(target) + memory) });
    expect(change).toMatchObject({ ok: false });
    expect(read(files.gemini)).toContain(memory);
    expect(read(files.gemini)).toContain(INBOX_NOTE_BLOCK);
    // Tried again: out, the memory kept.
    expect(removeInboxNote("gemini", dataDir, e, undefined, { auto: true })).toMatchObject({ ok: true });
    expect(read(files.gemini)).toContain(memory);
    expect(read(files.gemini)).not.toContain("plannotator-inbox");
  });

  test("one queue: an automatic add that began before code review only writes nothing after it began", async () => {
    mkdirSync(join(fake.home, ".gemini"), { recursive: true });
    const gemini = noteTarget("gemini", e).path!;
    writeFileSync(gemini, MINE_BEFORE);
    const one = computer({ inboxCodeReview: true });
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    one.onAuto(async (mayWrite) => {
      order.push("auto: candidates");
      await gate;
      if (mayWrite()) {
        order.push("auto: write");
        addInboxNote("gemini", dataDir, e, new Date(), { auto: true });
      }
    });
    const auto = one.notes.auto();
    await Promise.resolve();
    // Code review only begins while the add is between its read and its write.
    one.set({ inboxReviewOnly: true });
    const sync = one.notes.sync().then(() => order.push("sync"));
    release();
    await Promise.all([auto, sync]);
    expect(order).toEqual(["auto: candidates", "sync"]);
    expect(read(gemini)).toBe(MINE_BEFORE);
  });
});

describe("the switch", () => {
  test("code review only holds by itself: on with `inboxReviewOnly` alone; either way keeps Code review on", async () => {
    const one = computer();
    expect(one.reviewOnly.on()).toBe(false);
    await one.reviewOnly.save({ on: false });
    expect(one.config()).toMatchObject({ inboxCodeReview: true, inboxReviewOnly: true });
    // Code review's own key turned off by anything else does not end the mode.
    one.set({ inboxCodeReview: false });
    expect(one.reviewOnly.on()).toBe(true);
    expect(one.reviewOnly.words().reviewOnly).toBe(true);
    await one.reviewOnly.save({ on: true });
    expect(one.config()).toMatchObject({ inboxCodeReview: true, inboxReviewOnly: false });
    expect(one.said.changed).toBe(2);
  });

  test("on the wire: the full Inbox until chosen; `chosen` once the person was in the mode, so the row stays", () => {
    expect(computer().reviewOnly.wire()).toEqual({ full_inbox: { on: true } });
    expect(computer({ inboxReviewOnly: true }).reviewOnly.wire()).toEqual({ full_inbox: { on: false, chosen: true } });
    expect(computer({ inboxReviewOnly: false }).reviewOnly.wire()).toEqual({ full_inbox: { on: true, chosen: true } });
  });

  test("a bad body is refused and changes nothing", async () => {
    const one = computer({ inboxCodeReview: true });
    for (const bad of [null, true, { on: "no" }, { on: false, extra: 1 }, []]) await expect(one.reviewOnly.save(bad)).rejects.toThrow("full_inbox");
    expect(one.config().inboxReviewOnly).toBeUndefined();
  });

  test("a save that does not land says so", async () => {
    const stuck = createReviewOnly({ load: () => ({}), save: () => undefined, syncNotes: async () => {}, changed: () => {} });
    await expect(stuck.save({ on: false })).rejects.toThrow("config.json could not be saved");
  });

  test("the welcome is open for the line only while code review only, and only once `--review` asked for it", () => {
    const dueAt = "2026-11-25T09:00:00.000Z";
    expect(computer({ inboxReviewOnly: true, inboxReviewWelcome: { dueAt } }).reviewOnly.welcomeOpen()).toBe(true);
    expect(computer({ inboxReviewOnly: true }).reviewOnly.welcomeOpen()).toBe(false);
    expect(computer({ inboxReviewOnly: false, inboxReviewWelcome: { dueAt } }).reviewOnly.welcomeOpen()).toBe(false);
  });
});

describe("linked computers: the mode is this computer's own", () => {
  test("no Full Inbox switch in the shared set, in `plannotator inbox capability` or in a linked computer's capability route", () => {
    expect(INBOX_CAPABILITY_SET_KEYS as readonly string[]).not.toContain("full_inbox");
    expect(INBOX_CAPABILITY_SWITCH_KEYS).not.toContain("full_inbox");
    expect(INBOX_CAPABILITY_AGENT_IDS as readonly string[]).not.toContain("full_inbox");
  });

  /** A computer of the one set, its switches shared as inbox.ts shares them (`reviewOnlyShares`). */
  function linked(id: string, mode: boolean, start: Partial<Record<InboxCapabilitySetKey, boolean>>) {
    const on = Object.fromEntries(INBOX_CAPABILITY_SET_KEYS.map((key) => [key, start[key] ?? false])) as Record<InboxCapabilitySetKey, boolean>;
    const applied: string[] = [];
    let flips: Record<string, unknown> = {};
    let clock = 1_000;
    const set = createCapabilitySet({
      switches: Object.fromEntries(
        INBOX_CAPABILITY_SET_KEYS.map((key) => [
          key,
          { on: () => on[key], chosen: () => key in start, shared: () => reviewOnlyShares(key, mode), apply: (value: boolean) => void (applied.push(`${key} ${value}`), (on[key] = value)) },
        ]),
      ) as never,
      times: () => flips,
      saveTimes: (times) => void (flips = { ...flips, ...structuredClone(times) }),
      self: () => id,
      now: () => clock,
    });
    return {
      on,
      applied,
      set,
      flip(key: InboxCapabilitySetKey, value: boolean, at: number) {
        clock = at;
        on[key] = value;
        set.flipped([key]);
      },
    };
  }

  test("switching back to the full Inbox: a linked computer's flip of Code review made meanwhile never turns it off here", async () => {
    let clock = 9_000;
    // The laptop: `--review` stamped Code review on.
    let config: PlannotatorConfig = { inboxCodeReview: true, inboxReviewOnly: true, inboxCapabilityFlips: { code_review: { at: 9_000, by: null } } };
    const save = (patch: Partial<PlannotatorConfig>) => void (config = { ...config, ...structuredClone(patch) });
    const reviewOnly = createReviewOnly({
      load: () => structuredClone(config),
      save,
      syncNotes: async () => {},
      changed: () => {},
      codeReviewFlipped: () => laptop.flipped(["code_review"]),
    });
    const laptop = createCapabilitySet({
      switches: Object.fromEntries(
        INBOX_CAPABILITY_SET_KEYS.map((key) => [
          key,
          key === "code_review"
            ? { on: () => config.inboxCodeReview === true || reviewOnly.on(), chosen: () => config.inboxCodeReview !== undefined, shared: () => reviewOnlyShares(key, reviewOnly.on()), apply: (on: boolean) => save({ inboxCodeReview: on }) }
            : { on: () => false, chosen: () => false, shared: () => true, apply: () => {} },
        ]),
      ) as never,
      times: () => config.inboxCapabilityFlips,
      saveTimes: (times) => save({ inboxCapabilityFlips: { ...config.inboxCapabilityFlips, ...times } }),
      self: () => "ibx_01JZ0000000000000000000001",
      now: () => clock,
    });
    // The desktop turns Code review off while the laptop is code review only: not taken there.
    const desktop = linked("ibx_01JZ0000000000000000000002", false, { code_review: true });
    desktop.flip("code_review", false, 20_000);
    await laptop.take(desktop.set.wire());
    expect(config.inboxCodeReview).toBe(true);
    // The person switches the laptop back to the full Inbox, later; then the two meet again.
    clock = 30_000;
    await reviewOnly.save({ on: true });
    await laptop.take(desktop.set.wire());
    expect(config).toMatchObject({ inboxReviewOnly: false, inboxCodeReview: true });
  });

  test("a `--review` laptop linked to a full-Inbox desktop changes nothing there, and nothing there ends the mode, either order", async () => {
    for (const laptopFirst of [true, false]) {
      // The laptop: `--review` stamped Code review on (newest of all).
      const laptop = linked("ibx_01JZ0000000000000000000001", true, { code_review: true });
      laptop.flip("code_review", true, 9_000);
      // The desktop: the full Inbox, Code review off by the person's own earlier flip, the Board on.
      const desktop = linked("ibx_01JZ0000000000000000000002", false, { code_review: false, board: true });
      desktop.flip("code_review", false, 5_000);
      desktop.flip("board", true, 5_000);
      if (laptopFirst) {
        await desktop.set.take(laptop.set.wire());
        await laptop.set.take(desktop.set.wire());
      } else {
        await laptop.set.take(desktop.set.wire());
        await desktop.set.take(laptop.set.wire());
      }
      expect(desktop.applied).toEqual([]);
      expect(desktop.on.code_review).toBe(false);
      // The laptop keeps Code review on; the Board's value is kept there for when the person switches back.
      expect(laptop.on.code_review).toBe(true);
      expect(laptop.applied).toEqual(["board true"]);
      // A later flip of Code review off on the desktop does not reach the laptop while it is code review only.
      desktop.flip("code_review", false, 20_000);
      await laptop.set.take(desktop.set.wire());
      expect(laptop.on.code_review).toBe(true);
    }
  });
});
