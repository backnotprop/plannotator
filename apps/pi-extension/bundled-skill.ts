import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_SKILL_NAME = "plannotator";

export const BUNDLED_SKILL_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"skills",
	BUNDLED_SKILL_NAME,
	"SKILL.md",
);

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
