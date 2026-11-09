/**
 * The grill-me note on Pi (packages/shared/inbox/grill-me.ts, vendored to
 * `generated/inbox/`): when a grill-me skill runs, whoever wrote it, the model
 * also reads a short note saying its questions can go to the Plannotator
 * Inbox as `:::question` cards. Registered by `registerPiInbox` (inbox.ts)
 * only where the Inbox reminder is on (`inboxReminder`), and it says nothing
 * while `plannotator_inbox` is not active in the session (`isActive`: a
 * print/JSON run, which is also how a subagent extension runs its child Pi).
 *
 * Pi runs a skill two ways, and both are covered:
 * - The person types `/skill:grill-me`: Pi expands it into a
 *   `<skill name="grill-me" location="…">` block before `before_agent_start`,
 *   which then adds the note as a hidden custom message
 *   (`PI_GRILL_ME_CUSTOM_TYPE`, `display: false`) after the prompt.
 * - The model loads a skill itself with the `read` tool on its file: the
 *   `tool_result` of that read gets the note as one more text part. The skill
 *   is named by the file's frontmatter `name:`, its folder (`…/grill-me/SKILL.md`),
 *   or the loaded skill whose file it is (a root-level `grill-me.md`).
 *
 * Once per run: a typed `/skill:grill-me` whose skill then reads `grilling`'s
 * file in the same run gets one note. Every `before_agent_start` (a new
 * prompt) starts a new run.
 */

import { basename, dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { grillMeNoteText, isGrillMeSkill } from "./generated/inbox/grill-me.ts";

/**
 * The typed note's custom message. A new type, not the reminder's: the
 * reminder is sent once per session path (`entriesCarryReminder` looks for
 * its type), and a note kept in the branch must not count as that reminder.
 * It only ever follows the person's own prompt, so the "Ask this session"
 * bridge has already read that prompt as a take-over.
 */
export const PI_GRILL_ME_CUSTOM_TYPE = "plannotator-grill-me";

type GrillMePi = {
	on(event: string, handler: (event: any, ctx?: any) => unknown): unknown;
};

/** A skill Pi loaded, as `before_agent_start`'s `systemPromptOptions.skills` lists it. */
interface LoadedSkill {
	name?: unknown;
	filePath?: unknown;
}

/** The skill name in a typed `/skill:<name>` prompt as Pi expanded it (`<skill name="…" location="…">` first), or null. */
export function typedSkillName(prompt: unknown): string | null {
	if (typeof prompt !== "string") return null;
	const match = prompt.match(/^<skill name="([^"]+)" location="[^"]*">/);
	return match ? match[1]! : null;
}

/** The `name:` in a file's YAML frontmatter, when the text starts with one. */
function frontmatterName(text: string): string | null {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;
	for (let i = 1; i < lines.length && i < 60; i++) {
		const line = lines[i]!;
		if (line.trim() === "---") return null;
		const match = line.match(/^name:\s*["']?([^"'#\r\n]+?)["']?\s*$/);
		if (match) return match[1]!;
	}
	return null;
}

/** The read tool's path as an absolute path: Pi strips a leading `@` and expands `~`. */
function absoluteReadPath(raw: string, cwd: string | undefined): string {
	let file = raw.startsWith("@") ? raw.slice(1) : raw;
	if (file === "~") file = homedir();
	else if (file.startsWith("~/")) file = resolve(homedir(), file.slice(2));
	return isAbsolute(file) || !cwd ? file : resolve(cwd, file);
}

/**
 * The names a `read` tool call's file goes by as a skill: its frontmatter
 * `name:` and its folder when it is a `SKILL.md`, and the name of the loaded
 * skill whose file it is. Empty for any other file.
 */
export function skillNamesOfRead(
	input: { path?: unknown } | undefined,
	text: string,
	skills: readonly LoadedSkill[],
	cwd?: string,
): string[] {
	const raw = input?.path;
	if (typeof raw !== "string" || !raw) return [];
	const file = absoluteReadPath(raw, cwd);
	const names: string[] = [];
	const known = skills.find((skill) => typeof skill?.filePath === "string" && resolve(skill.filePath) === resolve(file));
	if (known && typeof known.name === "string") names.push(known.name);
	if (basename(file) === "SKILL.md") names.push(basename(dirname(file)));
	if (known || basename(file) === "SKILL.md") {
		const fromFile = frontmatterName(text);
		if (fromFile) names.push(fromFile);
	}
	return names;
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const first = content.find((part: { type?: unknown } | null) => part?.type === "text") as { text?: unknown } | undefined;
	return typeof first?.text === "string" ? first.text : "";
}

/**
 * The grill-me note's hooks. `isActive` answers whether `plannotator_inbox`
 * is active in this session right now; `toolName` is the name it was
 * registered under.
 */
export function registerPiGrillMe(pi: GrillMePi, options: { isActive: () => boolean; toolName?: string }): void {
	const note = grillMeNoteText(options.toolName);
	/** The note is already in this run. */
	let noted = false;
	/** The skills Pi loaded, from the latest run's system prompt options. */
	let skills: readonly LoadedSkill[] = [];

	pi.on("before_agent_start", (event: { prompt?: unknown; systemPromptOptions?: { skills?: unknown } } | undefined) => {
		noted = false;
		const loaded = event?.systemPromptOptions?.skills;
		if (Array.isArray(loaded)) skills = loaded as LoadedSkill[];
		if (!options.isActive() || !isGrillMeSkill(typedSkillName(event?.prompt))) return undefined;
		noted = true;
		return { message: { customType: PI_GRILL_ME_CUSTOM_TYPE, content: note, display: false } };
	});

	pi.on(
		"tool_result",
		(
			event: { toolName?: unknown; input?: { path?: unknown }; content?: unknown; isError?: unknown } | undefined,
			ctx?: { cwd?: string },
		) => {
			if (noted || event?.toolName !== "read" || event.isError || !options.isActive()) return undefined;
			let cwd: string | undefined;
			try {
				cwd = ctx?.cwd;
			} catch {
				// A stale ctx: a relative path is then matched as it is.
			}
			const names = skillNamesOfRead(event.input, textOf(event.content), skills, cwd);
			if (!names.some((name) => isGrillMeSkill(name))) return undefined;
			noted = true;
			const content = Array.isArray(event.content) ? event.content : [];
			return { content: [...content, { type: "text", text: note }] };
		},
	);
}
