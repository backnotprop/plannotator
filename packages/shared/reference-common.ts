// --- Vault file tree helpers ---

export const FILE_BROWSER_EXCLUDED = [
	"node_modules/",
	".git/",
	"dist/",
	"build/",
	".next/",
	"__pycache__/",
	".obsidian/",
	".trash/",
	".venv/",
	"vendor/",
	"target/",
	".cache/",
	"coverage/",
	".turbo/",
	".svelte-kit/",
	".nuxt/",
	".output/",
	".parcel-cache/",
	".webpack/",
	".expo/",
	"_site/",
	"public/",
	".jekyll-cache/",
	"out/",
	".docusaurus/",
	"storybook-static/",
];

export interface VaultNode {
	name: string;
	path: string; // relative path within vault
	type: "file" | "folder";
	children?: VaultNode[];
}

/**
 * Build a nested file tree from a sorted list of relative paths.
 * Folders are sorted before files at each level.
 */
export function buildFileTree(relativePaths: string[]): VaultNode[] {
	const root: VaultNode[] = [];

	for (const filePath of relativePaths) {
		const parts = filePath.split("/");
		let current = root;
		let pathSoFar = "";

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
			const isFile = i === parts.length - 1;

			let node = current.find(
				(n) => n.name === part && n.type === (isFile ? "file" : "folder"),
			);
			if (!node) {
				node = {
					name: part,
					path: pathSoFar,
					type: isFile ? "file" : "folder",
				};
				if (!isFile) node.children = [];
				current.push(node);
			}
			if (!isFile) {
				current = node.children!;
			}
		}
	}

	// Sort: folders first (alphabetical), then files (alphabetical)
	const sortNodes = (nodes: VaultNode[]) => {
		nodes.sort((a, b) => {
			if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const node of nodes) {
			if (node.children) sortNodes(node.children);
		}
	};
	sortNodes(root);

	return root;
}
