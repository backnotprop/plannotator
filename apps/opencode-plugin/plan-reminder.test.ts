import { describe, expect, test } from "bun:test";
import {
  isOpenCode2PlanReminder,
  openCode2PlanReminder,
  planReminderReplacement,
  replacePlanModeReminders,
  STRICT_PLAN_REMINDER_REPLACEMENT,
} from "./plan-reminder";

const DIRECTORY = "/home/dev/.opencode/plan";

const OPENCODE2_ENTER = `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
${DIRECTORY}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`;

const PRE_2_0_ENTER = `<system-reminder>
You are in Plan mode. You may optionally create or update plan documents in:
${DIRECTORY}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`;

const OPENCODE2_LEAVE = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`;

const OPENCODE1_STRICT = `<system-reminder>
# Plan Mode - System Reminder

CRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes. Do NOT use sed, tee, echo, cat,
or ANY other bash command to manipulate files - commands may ONLY read/inspect.
</system-reminder>`;

function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

function textOf(message: unknown): string {
  return ((message as { content: Array<{ text: string }> }).content[0]!).text;
}

describe("OpenCode 2's Plan mode reminder (#2101)", () => {
  test("the current reminder is rewritten to one that asks for submit_plan and keeps the plan directory", () => {
    const replaced = planReminderReplacement(OPENCODE2_ENTER);
    expect(replaced).toBe(openCode2PlanReminder(DIRECTORY));
    expect(replaced).toContain("submit it with the submit_plan tool");
    expect(replaced).toContain(`write it only in:\n${DIRECTORY}`);
    expect(replaced).not.toContain("Discuss the plan with the user directly");
    expect(replaced).not.toContain("Do not create or update plan files");
  });

  test("the pre-2.0 wording is recognized too", () => {
    expect(planReminderReplacement(PRE_2_0_ENTER)).toBe(openCode2PlanReminder(DIRECTORY));
  });

  test("a Windows plan directory is carried over", () => {
    const windows = "C:\\Users\\dev\\.opencode\\plan";
    expect(planReminderReplacement(OPENCODE2_ENTER.replace(DIRECTORY, windows))).toBe(openCode2PlanReminder(windows));
  });

  test("a reminder with no directory line still gets the rewrite, without the save rule", () => {
    const reminder = "<system-reminder>\nYou are in Plan mode. Discuss the plan with the user.\n</system-reminder>";
    expect(planReminderReplacement(reminder)).toBe(openCode2PlanReminder(undefined));
    expect(openCode2PlanReminder(undefined)).not.toContain("write it only in");
  });

  test("the exit reminder, the person's own words and our rewrite are left alone", () => {
    expect(planReminderReplacement(OPENCODE2_LEAVE)).toBeUndefined();
    expect(planReminderReplacement("You are in Plan mode. Discuss the plan with the user directly.")).toBeUndefined();
    expect(planReminderReplacement("Please make the plan STRICTLY FORBIDDEN to touch the db.")).toBeUndefined();
    expect(isOpenCode2PlanReminder(openCode2PlanReminder(DIRECTORY))).toBe(false);
    expect(planReminderReplacement(openCode2PlanReminder(DIRECTORY))).toBeUndefined();
  });

  test("an OpenCode 1-style STRICTLY FORBIDDEN reminder keeps the rewrite the OpenCode 2 adapter always sent", () => {
    expect(planReminderReplacement(OPENCODE1_STRICT)).toBe(STRICT_PLAN_REMINDER_REPLACEMENT);
    expect(planReminderReplacement(STRICT_PLAN_REMINDER_REPLACEMENT)).toBe(STRICT_PLAN_REMINDER_REPLACEMENT);
  });

  test("replacePlanModeReminders rewrites only user reminders, and the same history gives the same bytes every request", () => {
    const history = () => [
      userMessage("Plan the refactor."),
      { role: "assistant", content: [{ type: "text", text: OPENCODE2_ENTER }] },
      userMessage(OPENCODE2_ENTER),
      userMessage(OPENCODE2_LEAVE),
      userMessage("Now the next step."),
    ];
    const first = history();
    const second = history();
    replacePlanModeReminders(first);
    replacePlanModeReminders(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(textOf(first[0])).toBe("Plan the refactor.");
    expect(textOf(first[1])).toBe(OPENCODE2_ENTER);
    expect(textOf(first[2])).toBe(openCode2PlanReminder(DIRECTORY));
    expect(textOf(first[3])).toBe(OPENCODE2_LEAVE);
    expect(textOf(first[4])).toBe("Now the next step.");

    const again = JSON.stringify(first);
    replacePlanModeReminders(first);
    expect(JSON.stringify(first)).toBe(again);
  });

  test("odd message shapes are skipped without throwing", () => {
    const messages: unknown[] = [null, "text", { role: "user" }, { role: "user", content: "x" }, { role: "user", content: [null, { type: "image" }, { type: "text", text: 4 }] }];
    expect(() => replacePlanModeReminders(messages)).not.toThrow();
  });
});
