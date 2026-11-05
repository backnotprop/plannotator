/**
 * PR risk ranking (inbox-pull-risk.ts). What regresses: the verdict's parse going soft (a guess, or a diff's own
 * "verdict" being believed); work or cost repeating (per head, across restarts, after a failure); running when it must
 * not (off, no rules, an agent the person didn't choose); a run allowed to act; a big diff hiding what the rules ask about.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIMessage, AIProvider, CreateSessionOptions } from "@plannotator/ai/types";
import type { InboxPull, InboxPullDiffAnswer } from "@plannotator/core/inbox-types";
import { saveConfig } from "@plannotator/shared/config";
import { INBOX_PULL_RISK_FILE, RISK_CONCURRENCY, RISK_RETRY_MAX_MS, RISK_RETRY_MS, createPullRisk, defaultRiskModel, runRiskAgent, type RiskRun, type RiskRunner } from "./inbox-pull-risk";
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
function engine(options: { answer?: RiskRunner; agents?: { id: string; label: string }[]; on?: () => boolean; now?: () => number; head?: (key: string) => string | null; patch?: string; diffFails?: boolean } = {}) {
  const runs: RiskRun[] = [];
  const risk = createPullRisk({
    dataDir,
    isOn: options.on ?? (() => true),
    now: options.now,
    agents: () => options.agents ?? AGENTS,
    pulls: {
      diff: async (key) => {
        if (options.diffFails) throw new Error("gh failed");
        const number = key.split("#")[1];
        return { key, scope: "layer", base: "main", head: "x", patch: options.patch ?? "diff --git a/x b/x\n", head_sha: options.head ? options.head(key) : `head-${number}` } as InboxPullDiffAnswer;
      },
    },
    run: async (run) => {
      runs.push(run);
      return (options.answer ?? (async () => ({ text: HIGH })))(run);
    },
  });
  return { risk, runs };
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

  test("a failed run shows nothing and tries again later, waiting longer each time", async () => {
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
    await go();
    expect(runs).toHaveLength(2);
    now += RISK_RETRY_MS;
    await go();
    expect(runs).toHaveLength(3);
    // However long it has failed, it still comes back.
    for (let i = 0; i < 8; i++) {
      now += RISK_RETRY_MAX_MS;
      await go();
    }
    expect(runs).toHaveLength(11);
    text = HIGH;
    now += RISK_RETRY_MAX_MS;
    await go();
    expect(risk.answer().judgments["github.com/n/b#1"]?.level).toBe("high");
    expect(risk.answer().agent_failed).toBe(false);
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

  test("save takes the dialog's three fields and refuses anything else", () => {
    const { risk } = engine();
    risk.save({ rules: "  Billing.  ", provider: "pi-sdk", model: "a/b" });
    expect(risk.answer()).toMatchObject({ rules: "Billing.", provider: "pi-sdk", model: "a/b" });
    for (const bad of [{ rules: 1, provider: null, model: null }, { rules: "x".repeat(8_001), provider: null, model: null }, { rules: "x", provider: "rm -rf", model: null }, { rules: "x", provider: null, model: 3 }]) {
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
    const answer = await runRiskAgent(provider([{ type: "result", sessionId: "s", success: true, result: HIGH, costUsd: 0.01 }], seen), run);
    expect(answer).toEqual({ text: HIGH, costUsd: 0.01 });
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
});

describe("the model it starts on", () => {
  test("what the owner named first, then a small one, else the provider's own default", () => {
    expect(defaultRiskModel([{ id: "opus" }, { id: "sonnet", default: true }, { id: "haiku" }])).toBe("sonnet");
    expect(defaultRiskModel([{ id: "gpt-6-sol", default: true }, { id: "gpt-5.6-terra" }, { id: "gpt-5.6-luna" }])).toBe("gpt-5.6-terra");
    expect(defaultRiskModel([{ id: "google/gemini-pro" }, { id: "google/gemini-flash" }])).toBe("google/gemini-flash");
    expect(defaultRiskModel([{ id: "big" }, { id: "bigger", default: true }])).toBe("bigger");
    expect(defaultRiskModel([])).toBeNull();
  });
});
