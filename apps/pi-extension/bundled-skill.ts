/**
 * The bundled `plannotator` knowledge skill, offered to Pi only when no other
 * copy of it is loaded (#1642).
 *
 * The CLI installer (scripts/install.sh) writes the same skill to
 * ~/.agents/skills/plannotator, which Pi auto-discovers. When the package
 * declared the skill statically in `pi.skills`, every user with both installs
 * got a startup "[Skill conflicts]" warning: Pi ranks auto-discovered user
 * skills above package skills, keeps the first, and reports the other as
 * skipped. Contributing the skill from `resources_discover` instead lets the
 * extension look at what Pi already loaded and stay out of the way, so an
 * extension-only (npm) install still gets the skill and a CLI + extension
 * install loads exactly one copy: the installer's, which carries the user's
 * model-invocation choice.
 *
 * The bundled copy itself is user-invoked only: vendor.sh adds
 * `disable-model-invocation: true` to its frontmatter, so an npm-only install
 * keeps the #842 promise (no Plannotator skill in Pi's system prompt) while
 * `/skill:plannotator` still loads it. The model learns the tool from the
 * `plannotator` tool's own description.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Frontmatter `name` of apps/skills/core/plannotator/SKILL.md. */
export const BUNDLED_SKILL_NAME = "plannotator";

/** Where vendor.sh puts the skill inside the published package. */
export const BUNDLED_SKILL_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"skills",
	BUNDLED_SKILL_NAME,
	"SKILL.md",
);

/** The slice of Pi's `SlashCommandInfo` this decision reads. */
export interface LoadedCommand {
	name: string;
	source: string;
	sourceInfo?: { path?: string };
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Skill paths to hand back from `resources_discover`: the bundled skill, unless
 * Pi already loaded a skill with the same name from somewhere else. A loaded
 * skill that IS the bundled file (kept across a /reload) does not count, so
 * the extension keeps providing it.
 */
export function bundledSkillPaths(
	loadedCommands: readonly LoadedCommand[],
	skillPath: string = BUNDLED_SKILL_PATH,
	skillName: string = BUNDLED_SKILL_NAME,
): string[] {
	if (!existsSync(skillPath)) return [];
	const own = canonical(skillPath);
	const loadedElsewhere = loadedCommands.some(
		(command) =>
			command.source === "skill" &&
			command.name === `skill:${skillName}` &&
			canonical(command.sourceInfo?.path ?? "") !== own,
	);
	return loadedElsewhere ? [] : [skillPath];
}
