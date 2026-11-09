/**
 * The grill-me note on Pi (grill-me.ts). The failures this guards: a typed
 * `/skill:grill-me` or the model reading a grill-me skill's file without the
 * note; the note on another skill or file (`grilled-cheese`); the note while
 * `plannotator_inbox` is not active (a print/JSON run, a subagent's child Pi);
 * and a second note in one run.
 */
import { describe, expect, test } from "bun:test";
import { GRILL_ME_NOTE_TEXT } from "./generated/inbox/grill-me.ts";
import { PI_GRILL_ME_CUSTOM_TYPE, registerPiGrillMe, skillNamesOfRead, typedSkillName } from "./grill-me.ts";

type Handler = (event: any, ctx?: any) => any;

function fakePi(active = true) {
	const handlers = new Map<string, Handler[]>();
	let isActive = active;
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	registerPiGrillMe(pi, { isActive: () => isActive });
	const emit = (event: string, payload: unknown, ctx: unknown = { cwd: "/work" }) => handlers.get(event)?.map((handler) => handler(payload, ctx)).find(Boolean);
	return {
		setActive: (value: boolean) => {
			isActive = value;
		},
		/** A prompt as Pi hands it to `before_agent_start` (after `/skill:` expansion). */
		prompt: (text: string, skills: unknown[] = []) => emit("before_agent_start", { prompt: text, systemPromptOptions: { cwd: "/work", skills } }),
		/** A finished `read` call. */
		read: (file: string, text: string, isError = false) =>
			emit("tool_result", { type: "tool_result", toolName: "read", toolCallId: "t1", input: { path: file }, content: [{ type: "text", text }], isError }),
	};
}

const expanded = (name: string) => `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\nAsk me.\n</skill>\n\nthe plan`;
const skillFile = (name: string) => `---\nname: ${name}\ndescription: Interview me.\n---\n\n# Grill\n`;

describe("Pi grill-me note", () => {
	test("a typed /skill:grill-me gets the note as one hidden custom message", () => {
		const pi = fakePi();
		expect(pi.prompt(expanded("grill-me"))).toEqual({
			message: { customType: PI_GRILL_ME_CUSTOM_TYPE, content: GRILL_ME_NOTE_TEXT, display: false },
		});
	});

	test("the model reading a grill-me skill's file gets the note after the file", () => {
		const pi = fakePi();
		pi.prompt("interview me about the plan");
		const result = pi.read("/skills/grilling/SKILL.md", skillFile("grilling"));
		expect(result?.content).toEqual([
			{ type: "text", text: skillFile("grilling") },
			{ type: "text", text: GRILL_ME_NOTE_TEXT },
		]);
	});

	test("a root-level skill file is matched through the skills Pi loaded", () => {
		const pi = fakePi();
		pi.prompt("go", [{ name: "grill_me", filePath: "/work/.pi/skills/grill_me.md" }]);
		expect(pi.read(".pi/skills/grill_me.md", "# no frontmatter")?.content.at(-1)).toEqual({ type: "text", text: GRILL_ME_NOTE_TEXT });
	});

	test("another skill or file, or a failed read, gets nothing", () => {
		const pi = fakePi();
		expect(pi.prompt(expanded("grilled-cheese"))).toBeUndefined();
		expect(pi.read("/skills/grilled-cheese/SKILL.md", skillFile("grilled-cheese"))).toBeUndefined();
		// Any other file named in a grill-me folder that is not SKILL.md, or plain text that only mentions it.
		expect(pi.read("/skills/grill-me/references/rules.md", skillFile("grill-me"))).toBeUndefined();
		expect(pi.read("/work/notes.md", skillFile("grill-me"))).toBeUndefined();
		expect(pi.prompt(`please ${expanded("grill-me")}`)).toBeUndefined();
		expect(pi.read("/skills/grill-me/SKILL.md", "ENOENT", true)).toBeUndefined();
	});

	test("nothing while plannotator_inbox is not active", () => {
		const pi = fakePi(false);
		expect(pi.prompt(expanded("grill-me"))).toBeUndefined();
		expect(pi.read("/skills/grill-me/SKILL.md", skillFile("grill-me"))).toBeUndefined();
	});

	test("once per run: a typed /skill:grill-me that reads grilling's file adds one note; the next prompt starts over", () => {
		const pi = fakePi();
		expect(pi.prompt(expanded("grill-me"))).toBeDefined();
		expect(pi.read("/skills/grilling/SKILL.md", skillFile("grilling"))).toBeUndefined();
		pi.prompt("next question please");
		expect(pi.read("/skills/grilling/SKILL.md", skillFile("grilling"))).toBeDefined();
		expect(pi.read("/skills/grill-me/SKILL.md", skillFile("grill-me"))).toBeUndefined();
	});
});

describe("skill names", () => {
	test("a typed skill is read only from Pi's own expansion at the start of the prompt", () => {
		expect(typedSkillName(expanded("x:grill-me"))).toBe("x:grill-me");
		expect(typedSkillName("/skill:grill-me")).toBeNull();
	});

	test("a SKILL.md goes by its folder and its frontmatter name", () => {
		expect(skillNamesOfRead({ path: "@~/s/odd-folder/SKILL.md" }, skillFile("grillme"), [])).toEqual(["odd-folder", "grillme"]);
	});
});
