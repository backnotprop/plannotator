import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isFileBrowserExcludedPath } from "./reference-common";
import { getAnnotatableDocRegex, getFileBrowserMaxFiles } from "./resolve-file";

export interface FileBrowserListing {
	files: string[];
	truncated: boolean;
	limit: number;
}

export interface ListFileBrowserFilesOptions {
	seed?: Iterable<string>;
	limit?: number;
	docRegex?: RegExp;
}

function byName(a: Dirent, b: Dirent): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export async function listFileBrowserFiles(
	root: string,
	options: ListFileBrowserFilesOptions = {},
): Promise<FileBrowserListing> {
	const limit = options.limit ?? getFileBrowserMaxFiles();
	const docRegex = options.docRegex ?? getAnnotatableDocRegex();
	const files = new Set<string>();
	let truncated = false;

	const add = (relativePath: string): void => {
		if (files.has(relativePath)) return;
		if (files.size >= limit) {
			truncated = true;
			return;
		}
		files.add(relativePath);
	};

	for (const path of options.seed ?? []) {
		add(path);
		if (truncated) break;
	}

	const queue: string[] = [""];
	for (let next = 0; next < queue.length && !truncated; next++) {
		const relativeDir = queue[next];
		let entries: Dirent[];
		try {
			entries = (await readdir(relativeDir ? join(root, relativeDir) : root, {
				withFileTypes: true,
			})) as Dirent[];
		} catch {
			continue;
		}
		entries.sort(byName);
		for (const entry of entries) {
			const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!isFileBrowserExcludedPath(relativePath)) queue.push(relativePath);
			} else if (entry.isFile() && docRegex.test(entry.name)) {
				if (isFileBrowserExcludedPath(relativePath)) continue;
				add(relativePath);
				if (truncated) break;
			}
		}
	}

	return { files: [...files].sort(), truncated, limit };
}

export function explicitFileBrowserMaxFiles(): number {
	const value = Number.parseInt(process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}
