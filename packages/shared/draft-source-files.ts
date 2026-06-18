function sourceSavePath(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const sourceSave = (value as { sourceSave?: unknown }).sourceSave;
	if (!sourceSave || typeof sourceSave !== "object") return null;
	const path = (sourceSave as { path?: unknown }).path;
	return typeof path === "string" ? path : null;
}

export function draftContainsSourceSavePath(draft: unknown, path: string): boolean {
	if (!draft || typeof draft !== "object") return false;
	const data = draft as {
		editedDocuments?: unknown;
		savedFileChanges?: unknown;
	};

	const editedDocuments = Array.isArray(data.editedDocuments) ? data.editedDocuments : [];
	for (const doc of editedDocuments) {
		if (sourceSavePath(doc) === path) return true;
		const savedChange = doc && typeof doc === "object"
			? (doc as { savedChange?: unknown }).savedChange
			: null;
		if (sourceSavePath(savedChange) === path) return true;
	}

	const savedFileChanges = Array.isArray(data.savedFileChanges) ? data.savedFileChanges : [];
	for (const change of savedFileChanges) {
		if (sourceSavePath(change) === path) return true;
	}

	return false;
}
