import { realpathSync } from "fs";
import { dirname } from "path";
import { resolveUserPath } from "./resolve-file";

export interface AnnotateReferenceRootOptions {
	mode?: string;
	filePath: string;
	folderPath?: string;
	initialSingleFileSourcePath?: string | null;
	/**
	 * `annotate-bundle`: the bundle's files (absolute). Each contributes its
	 * directory, the single-file rule applied per file, so the documents a
	 * bundle file links to resolve exactly as they would if it were opened
	 * alone.
	 */
	bundlePaths?: readonly string[];
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
	if (options.mode === "annotate-bundle" && options.bundlePaths) {
		for (const path of options.bundlePaths) {
			addRoot(dirname(path));
			// A bundle file that is a symlink is served from where it really
			// lives, so the directory of its target becomes a root too (the
			// whole directory, as for a single-file session on that path).
			try {
				addRoot(dirname(realpathSync(path)));
			} catch {
				/* Missing now: /api/doc reports it when the file is opened. */
			}
		}
		return roots;
	}
	if (/^https?:\/\//i.test(options.filePath)) {
		return roots;
	}

	addRoot(dirname(options.filePath));
	addRoot(options.initialSingleFileSourcePath ? dirname(options.initialSingleFileSourcePath) : null);
	return roots;
}
