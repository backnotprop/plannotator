import { describe, expect, test } from "bun:test";
import { launchChoiceArgs, parseClaudeChoices, parseLaunchChoice, parsePiChoices } from "./inbox-launch-choice";

// Claude Code 2.1.322's and Pi 1.5's help, as their CLIs print it (wrapped).
const CLAUDE_HELP = `  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
`;
const PI_HELP = `  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --list-models [search]         List available models (with optional fuzzy search)`;
const PI_MODELS = `provider  model                     context  max-out  thinking  images
openai    gpt-5.5                   272K     128K     yes       yes
anthropic claude-opus-4-1           200K     32K      yes       yes
`;

describe("model and effort at launch", () => {
  test("the arguments each agent gets, and what never reaches argv", () => {
    const cases: [string, Parameters<typeof launchChoiceArgs>[1], string[]][] = [
      ["claude-code", {}, []],
      ["claude-code", { model: "opus" }, ["--model", "opus"]],
      ["claude-code", { effort: "max" }, ["--effort", "max"]],
      ["claude-code", { model: "claude-opus-4-1[1m]", effort: "high" }, ["--model", "claude-opus-4-1[1m]", "--effort", "high"]],
      ["pi", { model: "openai/gpt-5.5", effort: "minimal" }, ["--model", "openai/gpt-5.5", "--thinking", "minimal"]],
      ["codex", { model: "gpt-5.5", effort: "high" }, []],
      // A record edited by hand: a flag, a shell string or a space never become argv.
      ["claude-code", { model: "--dangerously-skip-permissions", effort: "-p" }, []],
      ["claude-code", { model: "opus; rm -rf ~", effort: "high now" }, []],
      ["claude-code", { model: "$(whoami)" }, []],
    ];
    for (const [agent, choice, args] of cases) expect(launchChoiceArgs(agent, choice), JSON.stringify([agent, choice])).toEqual(args);
  });

  test("a Send's choice: null is the default; a non-token or an unlisted level is refused with its field", () => {
    const efforts = ["low", "high", "max"];
    expect(parseLaunchChoice({}, efforts)).toEqual({});
    expect(parseLaunchChoice({ model: null, effort: null }, efforts)).toEqual({});
    expect(parseLaunchChoice({ model: "sonnet", effort: "max" }, efforts)).toEqual({ model: "sonnet", effort: "max" });
    expect(parseLaunchChoice({ effort: "ultra" }, null)).toEqual({ effort: "ultra" });
    const refused: [Record<string, unknown>, string][] = [
      [{ model: "-m" }, "model"],
      [{ model: "a b" }, "model"],
      [{ model: 42 }, "model"],
      [{ model: "" }, "model"],
      [{ effort: "ultra" }, "effort"],
      [{ effort: "--max" }, "effort"],
    ];
    for (const [raw, field] of refused) expect(() => parseLaunchChoice(raw, efforts), JSON.stringify(raw)).toThrow(expect.objectContaining({ field }));
  });

  test("the lists come from the installed CLI's help; unreadable help falls back to what 2.1.322 documents", () => {
    expect(parseClaudeChoices(CLAUDE_HELP)).toEqual({ models: ["fable", "opus", "sonnet"], efforts: ["low", "medium", "high", "xhigh", "max"], effort_word: "Effort" });
    expect(parseClaudeChoices(CLAUDE_HELP.replace("'sonnet'", "'sonnet', 'haiku'").replace("max)", "max, ultra)"))).toMatchObject({ models: ["fable", "opus", "sonnet", "haiku"], efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] });
    expect(parseClaudeChoices("Usage: claude [options]")).toEqual(parseClaudeChoices(CLAUDE_HELP));
    expect(parsePiChoices(PI_HELP, PI_MODELS)).toEqual({ models: ["openai/gpt-5.5", "anthropic/claude-opus-4-1"], efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], effort_word: "Thinking" });
    expect(parsePiChoices("", null).models).toEqual([]);
  });
});
