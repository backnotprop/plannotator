/**
 * PR risk ranking (inbox-pull-risk.ts). What regresses: the verdict's parse going soft (a guess, or a diff's own
 * "verdict" being believed); work or cost repeating (per head, across restarts, after a failure); running when it must
 * not (off, no rules, an agent the person didn't choose); a run allowed to act; a big diff hiding what the rules ask about.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIMessage, AIProvider, CreateSessionOptions } from "@plannotator/ai/types";
import type { InboxPull, InboxPullDiffAnswer } from "@plannotator/core/inbox-types";
import { saveConfig } from "@plannotator/shared/config";
import { INBOX_PULL_RISK_FILE, RISK_AGENT_PAUSE_MS, RISK_CONCURRENCY, RISK_RETRY_MS, createPullRisk, defaultRiskModel, installedPath, runRiskAgent, type RiskRun, type RiskRunner } from "./inbox-pull-risk";
import { buildRiskPrompt, parseRiskAnswer, trimDiffForRisk } from "./inbox-pull-risk-prompt";

const AGENTS = [{ id: "pi-sdk", label: "Pi" }];
const HIGH = '{"risk":"high","why":"It changes the billing webhook."}';

let dataDir: string;
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pull-risk-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const pull = (number: number, fields: Partial<InboxPull> = {}): InboxPull =>
  ({ key: `github.com/n/b#${number}`, number, title: `PR ${number}`, state: "open", head_sha: `head-${number}`, host: "github.com", repo: "n/b", ...fields }) as InboxPull;

const settled = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** An engine with a scripted agent and a scripted diff read; every run is kept in `runs`. */
function engine(options: { answer?: RiskRunner; agents?: { id: string; label: string }[]; on?: () => boolean; now?: () => number; head?: (key: string) => string | null; patch?: string; diffFails?: boolean | string; diffGate?: Promise<void> } = {}) {
  const runs: RiskRun[] = [];
  const reads: string[] = [];
  const risk = createPullRisk({
    dataDir,
    isOn: options.on ?? (() => true),
    now: options.now,
    agents: () => options.agents ?? AGENTS,
    pulls: {
      diff: async (key) => {
        reads.push(key);
        await options.diffGate;
        if (options.diffFails) throw Object.assign(new Error("gh failed"), typeof options.diffFails === "string" ? { code: options.diffFails } : {});
        const number = key.split("#")[1];
        return { key, scope: "layer", base: "main", head: "x", patch: options.patch ?? "diff --git a/x b/x\n", head_sha: options.head ? options.head(key) : `head-${number}` } as InboxPullDiffAnswer;
      },
    },
    run: async (run) => {
      runs.push(run);
      return (options.answer ?? (async () => ({ text: HIGH })))(run);
    },
  });
  return { risk, runs, reads };
}

const setRules = (rules = "Anything in billing.", provider: string | null = "pi-sdk", model: string | null = "anthropic/claude-sonnet-5") => saveConfig({ inboxPullRisk: { rules, provider, model } });

describe("the verdict's parse", () => {
  test("takes the one object, also in a single code fence", () => {
    expect(parseRiskAnswer(HIGH)).toEqual({ level: "high", why: "It changes the billing webhook." });
    expect(parseRiskAnswer(`\`\`\`json\n${HIGH}\n\`\`\``)?.level).toBe("high");
  });
  test.each([
    ["prose around it", `Sure! ${HIGH}`],
    ["a verdict after a reasoned one", `${HIGH}\n{"risk":"low","why":"ok"}`],
    ["an unknown level", '{"risk":"critical","why":"x"}'],
    ["a level in another case", '{"risk":"HIGH","why":"x"}'],
    ["no sentence", '{"risk":"low","why":"  "}'],
    ["an extra key", '{"risk":"low","why":"x","note":"y"}'],
    ["a sentence over lines", '{"risk":"low","why":"a\\nb"}'],
    ["a sentence too long", JSON.stringify({ risk: "low", why: "x".repeat(301) })],
    ["an array", `[${HIGH}]`],
    ["no answer", ""],
    ["plain words", "high"],
  ])("refuses %s", (_name, text) => {
    expect(parseRiskAnswer(text)).toBeNull();
  });
});

describe("what the agent reads", () => {
  const file = (path: string, lines: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${i} of ${path}`).join("\n")}\n`;

  test("a diff that fits goes whole", () => {
    const patch = file("src/a.ts", 3);
    expect(trimDiffForRisk(patch, 10_000)).toBe(patch);
  });
  test("a huge file can't push out a small change the rules ask about, and every path stays named", () => {
    const patch = file("src/huge.ts", 20_000) + file("src/billing/charge.ts", 2) + file("src/other.ts", 5_000);
    const out = trimDiffForRisk(patch);
    expect(out.length).toBeLessThan(42_000);
    expect(out).toContain("+line 1 of src/billing/charge.ts");
    expect(out).toContain("src/huge.ts (+20000 -0)");
    expect(out).toContain("src/other.ts (+5000 -0)");
    expect(out).toContain("more lines of this file not shown");
    expect(out).toContain("+line 0 of src/huge.ts");
    expect(out).toContain("+line 0 of src/other.ts");
  });
  test("the limit holds however many files: a list and notes count too", () => {
    for (const count of [500, 3_000]) {
      const patch = Array.from({ length: count }, (_, i) => file(`src/f${i}.ts`, 3)).join("");
      expect(trimDiffForRisk(patch, 40_000).length).toBeLessThanOrEqual(40_000);
    }
    const big = Array.from({ length: 40 }, (_, i) => file(`src/f${i}.ts`, 2_000)).join("");
    expect(trimDiffForRisk(big, 40_000).length).toBeLessThanOrEqual(40_000);
  });
  test("a PR padded with hundreds of small files can't push the file that matters out of the list", () => {
    const padded = Array.from({ length: 400 }, (_, i) => file(`docs/p${i}.md`, 3)).join("") + file("src/billing/charge.ts", 1) + file("src/billing/refund.ts", 40);
    const out = trimDiffForRisk(padded, 40_000);
    expect(out.length).toBeLessThanOrEqual(40_000);
    expect(out).toContain("src/billing/charge.ts (+1 -0)");
    expect(out).toContain("src/billing/refund.ts (+40 -0)");
    // The room goes to what it can show, smallest first, not to nobody.
    expect(out).toContain("+line 0 of src/billing/charge.ts");
  });
  test("a lockfile is named, not shown, even in a diff that would fit", () => {
    const out = trimDiffForRisk(file("bun.lock", 50) + file("src/a.ts", 2));
    expect(out).toContain("bun.lock (+50 -0) generated, not shown");
    expect(out).not.toContain("+line 0 of bun.lock");
    expect(out).toContain("+line 0 of src/a.ts");
  });
  test("a diff can't close the data fence, and the rules stay outside it", () => {
    const prompt = buildRiskPrompt({ rules: "Billing.", title: "t", diff: "+DATA-guess\n", fence: "DATA-real" });
    expect(prompt.indexOf("Billing.")).toBeLessThan(prompt.indexOf("DATA-real\nTitle:"));
    expect(prompt.split("\n").filter((line) => line === "DATA-real")).toHaveLength(2);
  });
});

describe("when it runs", () => {
  test("no rules, Code review off, no chosen agent, or an agent no longer installed: no run", async () => {
    const off = engine({ on: () => false });
    setRules();
    off.risk.assess([pull(1)]);
    await settled();
    expect(off.runs).toEqual([]);

    setRules("");
    const none = engine();
    none.risk.assess([pull(1)]);
    await settled();
    expect(none.runs).toEqual([]);

    setRules("Billing.", null);
    const unchosen = engine();
    unchosen.risk.assess([pull(1)]);
    await settled();
    expect(unchosen.runs).toEqual([]);

    // Claude Code is here, but the person chose Pi: a diff never goes to another provider.
    setRules("Billing.", "pi-sdk");
    const gone = engine({ agents: [{ id: "claude-agent-sdk", label: "Claude Code" }] });
    gone.risk.assess([pull(1)]);
    await settled();
    expect(gone.runs).toEqual([]);
  });

  test("a PR judged while open shows no judgment once merged, at the same head", async () => {
    setRules();
    const { risk } = engine();
    risk.assess([pull(1)]);
    await settled();
    expect(risk.answer().judgments["github.com/n/b#1"]?.level).toBe("high");
    risk.assess([pull(1, { state: "merged" })]);
    expect(risk.answer().judgments["github.com/n/b#1"]).toBeUndefined();
  });

  test("merged and closed PRs, and a PR whose head isn't known, are not judged", async () => {
    setRules();
    const { risk, runs } = engine();
    risk.assess([pull(1, { state: "merged" }), pull(2, { state: "closed" }), pull(3, { head_sha: null }), pull(4, { state: "draft" })]);
    await settled();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.prompt).toContain("Title: PR 4");
  });

  test("a few at a time, and the list never waits", async () => {
    setRules();
    let live = 0;
    let most = 0;
    const release: (() => void)[] = [];
    const { risk, runs } = engine({
      answer: async () => {
        most = Math.max(most, ++live);
        await new Promise<void>((resolve) => release.push(resolve));
        live--;
        return { text: HIGH };
      },
    });
    const pulls = Array.from({ length: 8 }, (_, i) => pull(i + 1));
    risk.assess(pulls);
    await settled();
    expect(risk.answer().pending).toBe(8);
    expect(most).toBe(RISK_CONCURRENCY);
    // A second list read while they run starts nothing twice.
    risk.assess(pulls);
    while (runs.length < 8 || release.length) {
      release.shift()?.();
      await settled();
    }
    expect(runs).toHaveLength(8);
    expect(risk.answer().pending).toBe(0);
    expect(Object.keys(risk.answer().judgments)).toHaveLength(8);
  });

  test("the agent gets the chosen model, an empty folder of its own, the rules and the diff", async () => {
    setRules("Anything in billing.");
    const { risk, runs } = engine({ patch: "diff --git a/pay.ts b/pay.ts\n+charge\n" });
    risk.assess([pull(1)]);
    await settled();
    expect(runs[0]).toMatchObject({ provider: "pi-sdk", model: "anthropic/claude-sonnet-5" });
    expect(runs[0]!.cwd).toBe(join(dataDir, "inbox", "pull-risk-agent"));
    expect(runs[0]!.prompt).toContain("Anything in billing.");
    expect(runs[0]!.prompt).toContain("+charge");
  });
});

describe("no cost repeats", () => {
  test("one judgment per head: kept across a restart; a new head means a new one, and the old one is not shown for it", async () => {
    setRules();
    const first = engine();
    first.risk.assess([pull(1)]);
    await settled();
    first.risk.assess([pull(1)]);
    await settled();
    expect(first.runs).toHaveLength(1);
    expect(first.risk.answer().judgments["github.com/n/b#1"]).toEqual({ level: "high", why: "It changes the billing webhook." });

    const restarted = engine();
    restarted.risk.assess([pull(1)]);
    await settled();
    expect(restarted.runs).toEqual([]);
    expect(restarted.risk.answer().judgments["github.com/n/b#1"]?.level).toBe("high");

    let release = () => {};
    const pushed = engine({ answer: () => new Promise((resolve) => (release = () => resolve({ text: '{"risk":"low","why":"Docs only."}' }))), head: () => "head-new" });
    pushed.risk.assess([pull(1, { head_sha: "head-new" })]);
    await settled();
    expect(pushed.risk.answer().judgments["github.com/n/b#1"]).toBeUndefined();
    release();
    await settled();
    expect(pushed.risk.answer().judgments["github.com/n/b#1"]?.level).toBe("low");
  });

  test("new rules mean a new judgment; a new model alone does not", async () => {
    setRules("Billing.");
    const { risk, runs } = engine();
    risk.assess([pull(1)]);
    await settled();
    setRules("Billing.", "pi-sdk", "anthropic/claude-haiku");
    risk.assess([pull(1)]);
    await settled();
    expect(runs).toHaveLength(1);
    setRules("Auth.");
    expect(risk.answer().judgments).toEqual({});
    risk.assess([pull(1)]);
    await settled();
    expect(runs).toHaveLength(2);
    expect(risk.answer().judgments["github.com/n/b#1"]).toBeDefined();
  });

  test("a failed run shows nothing, and that PR waits the same time before each try", async () => {
    setRules();
    let now = 1_000_000;
    let text = "I think this is low risk.";
    const { risk, runs } = engine({ now: () => now, answer: async () => ({ text }) });
    const go = async () => {
      risk.assess([pull(1)]);
      await settled();
    };
    await go();
    expect(runs).toHaveLength(1);
    expect(risk.answer().judgments).toEqual({});
    expect(risk.answer().agent_failed).toBe(true);
    await go();
    now += RISK_RETRY_MS - 1;
    await go();
    expect(runs).toHaveLength(1);
    now += 1;
    await go();
    expect(runs).toHaveLength(2);
    now += RISK_RETRY_MS;
    text = HIGH;
    await go();
    expect(runs).toHaveLength(3);
    expect(risk.answer().judgments["github.com/n/b#1"]?.level).toBe("high");
    expect(risk.answer().agent_failed).toBe(false);
  });

  const many = Array.from({ length: 30 }, (_, i) => pull(i + 1));

  test("a broken agent stops everything for a while: a few runs, not one per PR, and the window stops waiting", async () => {
    setRules();
    let now = 1_000_000;
    const { risk, runs, reads } = engine({ now: () => now, answer: async () => null });
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    expect(reads).toHaveLength(RISK_CONCURRENCY);
    expect(risk.answer().pending).toBe(0);
    expect(risk.answer().agent_failed).toBe(true);

    now += RISK_AGENT_PAUSE_MS - 1;
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);

    // After the pause, the next few, not the same ones.
    now += 1;
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY * 2);
    expect(new Set(runs.map((r) => r.prompt)).size).toBe(RISK_CONCURRENCY * 2);
  });

  test("one PR that keeps failing can't stop the others", async () => {
    setRules();
    const { risk, runs } = engine({ answer: async (run) => (run.prompt.includes("Title: PR 1\n") ? { text: "not json" } : { text: HIGH }) });
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(many.length);
    expect(Object.keys(risk.answer().judgments)).toHaveLength(many.length - 1);
  });

  test("saving starts over at once: the person just looked at it", async () => {
    setRules();
    let answer: { text: string } | null = null;
    const { risk, runs } = engine({ answer: async () => answer });
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    answer = { text: HIGH };
    risk.save({ rules: "Anything in billing.", provider: "pi-sdk", model: null });
    expect(risk.answer().agent_failed).toBe(false);
    risk.assess(many);
    await settled();
    expect(Object.keys(risk.answer().judgments)).toHaveLength(many.length);
  });

  test("a diff too large to read isn't read again at this head; another failed read is, later", async () => {
    setRules();
    let now = 1_000_000;
    const large = engine({ now: () => now, diffFails: "pull_diff_too_large" });
    large.risk.assess([pull(1)]);
    await settled();
    now += RISK_RETRY_MS * 100;
    large.risk.assess([pull(1)]);
    await settled();
    expect(large.reads).toHaveLength(1);
    expect(large.runs).toEqual([]);

    const flaky = engine({ now: () => now, diffFails: true });
    flaky.risk.assess([pull(2)]);
    await settled();
    now += RISK_RETRY_MS;
    flaky.risk.assess([pull(2)]);
    await settled();
    expect(flaky.reads).toHaveLength(2);
  });

  /** The first runs hold the line, so the rest wait in the queue; `release` lets them go. */
  const held = (on: () => boolean = () => true) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const made = engine({
      on,
      answer: async () => {
        await gate;
        return { text: HIGH };
      },
    });
    return { ...made, release };
  };

  test("the switch going off while PRs wait: those run nothing", async () => {
    setRules();
    let on = true;
    const { risk, runs, release } = held(() => on);
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    on = false;
    release();
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    expect(risk.answer().pending).toBe(0);
  });

  test("the rules changing while PRs wait: those run nothing against the old ones", async () => {
    setRules();
    const { risk, runs, release } = held();
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    setRules("Something else.");
    release();
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
  });

  test("the Inbox stopping during a diff read: no agent starts", async () => {
    setRules();
    let release = () => {};
    const { risk, runs, reads } = engine({ diffGate: new Promise<void>((resolve) => (release = resolve)) });
    risk.assess([pull(1)]);
    await settled();
    expect(reads).toHaveLength(1);
    risk.stop();
    release();
    await settled();
    expect(runs).toEqual([]);
  });

  test("the Inbox stopping: nothing more runs, nothing is written, and a later list starts nothing", async () => {
    setRules();
    const { risk, runs, release } = held();
    risk.assess(many);
    await settled();
    risk.stop();
    release();
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    expect(existsSync(join(dataDir, "inbox", INBOX_PULL_RISK_FILE))).toBe(false);
    risk.assess(many);
    await settled();
    expect(runs).toHaveLength(RISK_CONCURRENCY);
    expect(risk.answer().pending).toBe(0);
  });

  test("a diff that can't be read, or whose head moved, costs no agent run", async () => {
    setRules();
    const unread = engine({ diffFails: true });
    unread.risk.assess([pull(1)]);
    await settled();
    expect(unread.runs).toEqual([]);
    const moved = engine({ head: () => "head-moved" });
    moved.risk.assess([pull(1)]);
    await settled();
    expect(moved.runs).toEqual([]);
    expect(moved.risk.answer().judgments).toEqual({});
  });
});

describe("the sentence", () => {
  test("characters that reorder text on screen are taken out, from an answer and from what was kept", async () => {
    const tricky = "It changes \u202Eetirw\u202C the \u2066billing\u2069 webhook\u200F.";
    expect(parseRiskAnswer(JSON.stringify({ risk: "high", why: tricky }))).toEqual({ level: "high", why: "It changes etirw the billing webhook." });
    expect(parseRiskAnswer(JSON.stringify({ risk: "high", why: "\u202E\u2066" }))).toBeNull();

    setRules();
    const { risk } = engine();
    risk.assess([pull(1)]);
    await settled();
    const file = join(dataDir, "inbox", INBOX_PULL_RISK_FILE);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.judgments["github.com/n/b#1"].why = tricky;
    writeFileSync(file, JSON.stringify(stored));
    const restarted = engine();
    restarted.risk.assess([pull(1)]);
    expect(restarted.risk.answer().judgments["github.com/n/b#1"]?.why).toBe("It changes etirw the billing webhook.");
  });
});

describe("the person's rules", () => {
  test("stay out of the judgments' file", async () => {
    setRules("Anything about the secret merger.");
    const { risk } = engine();
    risk.assess([pull(1)]);
    await settled();
    const file = join(dataDir, "inbox", INBOX_PULL_RISK_FILE);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain("merger");
  });

  test("long rules are the person's to write: a paste isn't cut", () => {
    const { risk } = engine();
    const long = "Anything in billing. ".repeat(2_000).trim();
    risk.save({ rules: long, provider: "pi-sdk", model: null });
    expect(risk.answer().rules).toBe(long);
  });

  test("save takes the dialog's three fields and refuses anything else", () => {
    const { risk } = engine();
    risk.save({ rules: "  Billing.  ", provider: "pi-sdk", model: "a/b" });
    expect(risk.answer()).toMatchObject({ rules: "Billing.", provider: "pi-sdk", model: "a/b" });
    for (const bad of [{ rules: 1, provider: null, model: null }, { rules: "x", provider: "rm -rf", model: null }, { rules: "x", provider: null, model: 3 }]) {
      expect(() => risk.save(bad)).toThrow();
    }
    expect(risk.answer().rules).toBe("Billing.");
  });
});

describe("one run on a provider", () => {
  const provider = (messages: AIMessage[] | (() => AsyncIterable<AIMessage>), seen: { options?: CreateSessionOptions; aborted?: boolean } = {}): AIProvider =>
    ({
      name: "stub",
      models: [{ id: "big" }, { id: "claude-sonnet-5", reasoningEfforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }] }, { id: "claude-haiku-4-5" }],
      createSession: async (options: CreateSessionOptions) => {
        seen.options = options;
        return {
          abort: () => (seen.aborted = true),
          query: typeof messages === "function" ? messages : async function* () { yield* messages; },
        };
      },
    }) as unknown as AIProvider;
  const run = { model: null, system: "SYSTEM", prompt: "PROMPT", cwd: "/empty" };

  test("no tools, one turn, the empty folder, the cheap default at its lowest effort", async () => {
    const seen: { options?: CreateSessionOptions } = {};
    const answer = await runRiskAgent(provider([{ type: "result", sessionId: "s", success: true, result: HIGH }], seen), run);
    expect(answer).toEqual({ text: HIGH });
    expect(seen.options).toMatchObject({ cwd: "/empty", model: "claude-sonnet-5", reasoningEffort: "low", maxTurns: 1, oneShot: { systemPrompt: "SYSTEM" } });
  });

  test("a model that takes no effort gets none", async () => {
    const seen: { options?: CreateSessionOptions } = {};
    await runRiskAgent(provider([], seen), { ...run, model: "claude-haiku-4-5" });
    expect(seen.options!.reasoningEffort).toBeUndefined();
  });

  test.each([
    ["uses a tool", { type: "tool_use", toolName: "Bash", toolInput: {}, toolUseId: "t" }],
    ["asks permission", { type: "permission_request", requestId: "r", toolName: "Bash", toolInput: {}, toolUseId: "t" }],
    ["errors", { type: "error", error: "nope" }],
  ] as [string, AIMessage][])("an agent that %s ends the run, with no answer even after a verdict", async (_name, message) => {
    const seen: { aborted?: boolean } = {};
    const answer = await runRiskAgent(provider([{ type: "text", text: HIGH }, message, { type: "result", sessionId: "s", success: true, result: HIGH }], seen), run);
    expect(answer).toBeNull();
    expect(seen.aborted).toBe(true);
  });

  test("an agent that never answers ends at the timeout", async () => {
    const hung = provider(async function* () {
      await new Promise(() => {});
    });
    expect(await runRiskAgent(hung, run, 5)).toBeNull();
  });

  test("a stop ends a running agent at once, and closes it", async () => {
    const seen: { aborted?: boolean } = {};
    const hung = provider(async function* () {
      await new Promise(() => {});
    }, seen);
    const stopping = new AbortController();
    const answer = runRiskAgent(hung, run, 60_000, stopping.signal);
    await Bun.sleep(5);
    stopping.abort();
    expect(await answer).toBeNull();
    expect(seen.aborted).toBe(true);
  });

  test("a stop during the model read: no agent starts after it", async () => {
    const seen: { options?: CreateSessionOptions } = {};
    let finish = () => {};
    const stub = provider([], seen) as unknown as { models: unknown[]; fetchModels: () => Promise<void> };
    stub.models = [];
    stub.fetchModels = () => new Promise<void>((resolve) => (finish = resolve));
    const stopping = new AbortController();
    const answer = runRiskAgent(stub as unknown as AIProvider, run, 60_000, stopping.signal);
    await Bun.sleep(5);
    stopping.abort();
    expect(await answer).toBeNull();
    finish();
    await Bun.sleep(5);
    expect(seen.options).toBeUndefined();
  });

  test("an agent that never opens its session ends at the timeout too, and the session is closed if it comes late", async () => {
    let open = (_: unknown) => {};
    let closed = 0;
    const hung = {
      name: "stub",
      models: [],
      createSession: () => new Promise((resolve) => (open = resolve)),
    } as unknown as AIProvider;
    expect(await runRiskAgent(hung, run, 5)).toBeNull();
    open({ abort: () => closed++, dispose: () => closed++, query: async function* () {} });
    await Bun.sleep(5);
    expect(closed).toBe(2);
  });

  test("no model saved and none known yet: it reads the list and takes the cheap one, instead of the person's default", async () => {
    const seen: { options?: CreateSessionOptions } = {};
    const stub = provider([{ type: "result", sessionId: "s", success: true, result: HIGH }], seen) as unknown as { models: unknown[]; fetchModels: () => Promise<void> };
    stub.models = [];
    stub.fetchModels = async () => {
      stub.models = [{ id: "a/claude-opus" }, { id: "a/claude-sonnet-5" }];
    };
    await runRiskAgent(stub as unknown as AIProvider, run);
    expect(seen.options!.model).toBe("a/claude-sonnet-5");
  });
});

describe("the model it starts on", () => {
  test("what the owner named first, then a small one, else the provider's own default", () => {
    expect(defaultRiskModel([{ id: "opus" }, { id: "sonnet", default: true }, { id: "haiku" }])).toBe("sonnet");
    expect(defaultRiskModel([{ id: "gpt-6-sol", default: true }, { id: "gpt-5.6-terra" }, { id: "gpt-5.6-luna" }])).toBe("gpt-5.6-terra");
    expect(defaultRiskModel([{ id: "google/gemini-pro" }, { id: "google/gemini-flash" }])).toBe("google/gemini-flash");
    expect(defaultRiskModel([{ id: "big" }, { id: "bigger", default: true }])).toBe("bigger");
    // Gemini has "mini" in it; a mini model is another thing.
    expect(defaultRiskModel([{ id: "opus", default: true }, { id: "google/gemini-3-pro" }])).toBe("opus");
    expect(defaultRiskModel([{ id: "opus", default: true }, { id: "o4-mini" }])).toBe("o4-mini");
    expect(defaultRiskModel([])).toBeNull();
  });
});

describe("finding the agent", () => {
  const savedPath = process.env.PATH;
  const savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
  });

  test("a test Inbox finds its fake in a temp folder, and never a CLI outside one", () => {
    const fake = join(dataDir, "fake-agent");
    writeFileSync(fake, "#!/bin/sh\n");
    chmodSync(fake, 0o755);
    process.env.PATH = `${dataDir}:/bin:/usr/bin`;
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
    expect(installedPath("fake-agent")).toBe(fake);
    expect(installedPath("sh")).toBeNull();
    delete process.env.PLANNOTATOR_TEST_SANDBOX;
    expect(installedPath("sh")).not.toBeNull();
  });
});
