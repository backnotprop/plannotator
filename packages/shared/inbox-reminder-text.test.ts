/**
 * The customizable Inbox reminder (#2194): `prompts.inbox` in config.json.
 *
 * The owner's condition: a config.json without `prompts.inbox` must give
 * every host byte for byte the reminder it gave before. These tests pin that
 * against the built-in lines (copied here as literals too, so a resolver that
 * started building the default some other way would fail), then the rules of
 * the custom text: per-agent wins, blank or over the cap is unset, the tool
 * name is renamed, and saving one key keeps every other.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergePromptConfig, resolveInboxReminderText, saveConfig, type PlannotatorConfig } from "./config";
import {
  INBOX_REMINDER_MAX_CHARS,
  INBOX_REMINDER_TEXT,
  INBOX_REMINDER_TEXT_NO_WAKE,
  INBOX_TOOL_NAME,
  inboxReminderCustomText,
  inboxReminderFor,
  inboxReminderText,
} from "./inbox/connection";

/** The built-in lines (the constants: what they say is pinned by what they must carry, below). */
const MAIN_WAKE = INBOX_REMINDER_TEXT;
const MAIN_NO_WAKE = INBOX_REMINDER_TEXT_NO_WAKE;
const MOD_TOOL = "mcp__plugin_plannotator_plannotator__plannotator_inbox";

/** Every config.json that sets no usable `prompts.inbox`. */
const UNSET: PlannotatorConfig[] = [
  {},
  { inboxReminder: true },
  { prompts: {} },
  { prompts: { review: { denied: "Check each finding." }, plan: { runtimes: { pi: { approved: "ok" } } } } },
  { prompts: { inbox: {} } },
  { prompts: { inbox: { reminder: "" } } },
  { prompts: { inbox: { reminder: "   \n\t" } } },
  { prompts: { inbox: { reminder: "x".repeat(INBOX_REMINDER_MAX_CHARS + 1) } } },
  { prompts: { inbox: { runtimes: { "claude-code": { reminder: " " }, pi: {}, opencode: { reminder: "" } } } } },
  { prompts: { inbox: { reminder: 42, runtimes: "nope" } } } as unknown as PlannotatorConfig,
  { prompts: { inbox: "a string" } } as unknown as PlannotatorConfig,
];

describe("no prompts.inbox: every host gets the built-in line, byte for byte", () => {
  test("the built-in lines carry the rules a session needs with no setup", () => {
    for (const line of [INBOX_REMINDER_TEXT, INBOX_REMINDER_TEXT_NO_WAKE]) {
      expect(line).toContain(`${INBOX_TOOL_NAME} send_message`);
      expect(line).toContain("plannotator inbox --help");
      // The chat-or-Inbox rule (the owner, 2026-10-27): never a blocking chat question for an Inbox decision.
      expect(line).toContain("never also ask it in the chat with a blocking question tool");
      expect(line).not.toContain("isn't here");
    }
    // Only the line for a host without the wake sends the agent to wait_for_reply.
    expect(INBOX_REMINDER_TEXT).not.toContain("wait_for_reply");
    expect(INBOX_REMINDER_TEXT_NO_WAKE).toContain("wait_for_reply");
  });

  for (const [index, config] of UNSET.entries()) {
    test(`unset config #${index}`, () => {
      for (const host of ["claude-code", "pi", "opencode"] as const) {
        // Pi and OpenCode 2 with the wake; OpenCode 1 and OpenCode 2 without session.prompt; the Claude Code mod with its full tool name.
        expect(resolveInboxReminderText(config, host)).toBe(inboxReminderText(INBOX_TOOL_NAME));
        expect(resolveInboxReminderText(config, host)).toBe(MAIN_WAKE);
        expect(resolveInboxReminderText(config, host, { wakes: true })).toBe(MAIN_WAKE);
        expect(resolveInboxReminderText(config, host, { wakes: false })).toBe(inboxReminderText(INBOX_TOOL_NAME, { wakes: false }));
        expect(resolveInboxReminderText(config, host, { wakes: false })).toBe(MAIN_NO_WAKE);
        expect(resolveInboxReminderText(config, host, { toolName: MOD_TOOL })).toBe(inboxReminderText(MOD_TOOL));
        expect(inboxReminderCustomText(config, host)).toBeNull();
      }
    });
  }
});

describe("custom reminder text", () => {
  test("it replaces the line, for hosts with the wake and without it alike", () => {
    const config: PlannotatorConfig = { prompts: { inbox: { reminder: "Report upstream first." } } };
    expect(resolveInboxReminderText(config, "pi")).toBe("Report upstream first.");
    expect(resolveInboxReminderText(config, "opencode", { wakes: false })).toBe("Report upstream first.");
    expect(resolveInboxReminderText(config, "claude-code", { toolName: MOD_TOOL })).toBe("Report upstream first.");
  });

  test("an agent's own text wins over the shared text; another agent keeps the shared one", () => {
    const config: PlannotatorConfig = { prompts: { inbox: { reminder: "Shared.", runtimes: { pi: { reminder: "Pi's own." } } } } };
    expect(resolveInboxReminderText(config, "pi")).toBe("Pi's own.");
    expect(resolveInboxReminderText(config, "opencode")).toBe("Shared.");
    expect(resolveInboxReminderText(config, "claude-code")).toBe("Shared.");
    // An agent's own entry alone: the others keep the default.
    const only: PlannotatorConfig = { prompts: { inbox: { runtimes: { opencode: { reminder: "OpenCode's own." } } } } };
    expect(resolveInboxReminderText(only, "opencode", { wakes: false })).toBe("OpenCode's own.");
    expect(resolveInboxReminderText(only, "pi")).toBe(MAIN_WAKE);
  });

  test("blank or over-cap agent text falls back to the shared text; at the cap it holds", () => {
    const atCap = "y".repeat(INBOX_REMINDER_MAX_CHARS);
    const over = `${atCap}y`;
    expect(resolveInboxReminderText({ prompts: { inbox: { reminder: "Shared.", runtimes: { pi: { reminder: "  " } } } } }, "pi")).toBe("Shared.");
    expect(resolveInboxReminderText({ prompts: { inbox: { reminder: "Shared.", runtimes: { pi: { reminder: over } } } } }, "pi")).toBe("Shared.");
    expect(resolveInboxReminderText({ prompts: { inbox: { reminder: atCap } } }, "pi")).toBe(atCap);
  });

  test("the text is kept as written: whitespace, line breaks, quotes", () => {
    const text = "  Line one.\n\nLine two: \"quoted\" and `code`.\n";
    expect(resolveInboxReminderText({ prompts: { inbox: { reminder: text } } }, "pi")).toBe(text);
  });

  test("every whole word plannotator_inbox becomes the host's registered tool name, nothing else", () => {
    const text = "Use plannotator_inbox send_message; plannotator_inbox's wait_for_reply too. Not my_plannotator_inbox or plannotator_inbox2, and mcp__x__plannotator_inbox stays.";
    expect(inboxReminderFor(text, MOD_TOOL)).toBe(
      `Use ${MOD_TOOL} send_message; ${MOD_TOOL}'s wait_for_reply too. Not my_plannotator_inbox or plannotator_inbox2, and mcp__x__plannotator_inbox stays.`,
    );
    // A tool name with `$` is inserted as it is (no replacement patterns).
    expect(inboxReminderFor("plannotator_inbox", "a$&b")).toBe("a$&b");
    expect(inboxReminderFor(text, INBOX_TOOL_NAME)).toBe(text);
  });
});

describe("mergePromptConfig: prompts.inbox", () => {
  test("one key at a time; undefined deletes; an emptied entry and section go", () => {
    const current = { review: { denied: "Keep." }, inbox: { reminder: "Shared.", runtimes: { pi: { reminder: "Pi." }, opencode: { reminder: "OC." } } } };
    expect(mergePromptConfig(current, { inbox: { runtimes: { pi: { reminder: "Pi 2." } } } })).toEqual({
      review: { denied: "Keep." },
      inbox: { reminder: "Shared.", runtimes: { pi: { reminder: "Pi 2." }, opencode: { reminder: "OC." } } },
    });
    expect(mergePromptConfig(current, { inbox: { reminder: undefined } })).toEqual({
      review: { denied: "Keep." },
      inbox: { runtimes: { pi: { reminder: "Pi." }, opencode: { reminder: "OC." } } },
    });
    const without = mergePromptConfig({ inbox: { runtimes: { pi: { reminder: "Pi." } } } }, { inbox: { runtimes: { pi: { reminder: undefined } } } });
    expect(without).toBeUndefined();
  });

  test("a write without inbox leaves whatever config.json holds there as it is", () => {
    const odd = { inbox: { reminder: 7, runtimes: "x" } } as never;
    expect(mergePromptConfig(odd, { review: { denied: "New." } })).toEqual({ inbox: { reminder: 7, runtimes: "x" }, review: { denied: "New." } } as never);
  });
});

describe("saveConfig with prompts.inbox", () => {
  let previous: string | undefined;
  let root: string | null = null;
  afterEach(() => {
    if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = previous;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  test("keeps every other key in config.json, and the other prompts sections byte for byte", () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-reminder-config-")));
    previous = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = root;
    const before = {
      displayName: "Ann",
      prompts: { plan: { runtimes: { opencode: { approved: "OC ok." } }, approved: "ok" }, review: { denied: "Keep." } },
    };
    writeFileSync(join(root, "config.json"), JSON.stringify(before));
    expect(saveConfig({ prompts: { inbox: { reminder: "Shared." } } })).toBe(true);
    const after = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    expect(after).toEqual({ ...before, prompts: { ...before.prompts, inbox: { reminder: "Shared." } } });
    // Key order of the sections this write did not name is kept.
    expect(JSON.stringify(after.prompts.plan)).toBe(JSON.stringify(before.prompts.plan));
    expect(saveConfig({ prompts: { inbox: { reminder: undefined } } })).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8"))).toEqual(before);
  });
});
