import { realpathSync } from "fs";
import { dirname } from "path";
import { resolveUserPath } from "./resolve-file";

export interface AnnotateReferenceRootOptions {
	mode?: string;
	filePath: string;
	folderPath?: string;
	initialSingleFileSourcePath?: string | null;
}

export function getAnnotateReferenceRootPaths(options: AnnotateReferenceRootOptions): string[] {
	const roots: string[] = [];
	const addRoot = (root: string | null | undefined) => {
		if (!root) return;
		const resolved = resolveUserPath(root);
		if (!roots.includes(resolved)) roots.push(resolved);
		try {
			const real = realpathSync(resolved);
			if (!roots.includes(real)) roots.push(real);
		} catch {
			/* Missing source paths still contribute their lexical parent. */
		}
	};

	if (options.mode === "annotate-folder" && options.folderPath) {
		addRoot(options.folderPath);
		return roots;
	}

	addRoot(process.cwd());
	if (/^https?:\/\//i.test(options.filePath)) {
		return roots;
	}

	addRoot(dirname(options.filePath));
	addRoot(options.initialSingleFileSourcePath ? dirname(options.initialSingleFileSourcePath) : null);
	return roots;
}
