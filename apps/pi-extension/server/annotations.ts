/**
 * Editor annotation handler (in-memory store for VS Code integration).
 * EditorAnnotation type, createEditorAnnotationHandler
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { json, parseBody } from "./helpers.ts";

interface EditorAnnotation {
	id: string;
	filePath: string;
	selectedText: string;
	lineStart: number;
	lineEnd: number;
	comment?: string;
	createdAt: number;
}

export function createEditorAnnotationHandler() {
	const annotations: EditorAnnotation[] = [];

	return {
		async handle(
			req: IncomingMessage,
			res: import("node:http").ServerResponse,
			url: URL,
		): Promise<boolean> {
			if (url.pathname === "/api/editor-annotations" && req.method === "GET") {
				json(res, { annotations });
				return true;
			}

			if (url.pathname === "/api/editor-annotation" && req.method === "POST") {
				try {
					const body = await parseBody(req);
					if (
						!body.filePath ||
						!body.selectedText ||
						!body.lineStart ||
						!body.lineEnd
					) {
						json(res, { error: "Missing required fields" }, 400);
						return true;
					}

					const annotation: EditorAnnotation = {
						id: randomUUID(),
						filePath: String(body.filePath),
						selectedText: String(body.selectedText),
						lineStart: Number(body.lineStart),
						lineEnd: Number(body.lineEnd),
						comment: typeof body.comment === "string" ? body.comment : undefined,
						createdAt: Date.now(),
					};

					annotations.push(annotation);
					json(res, { id: annotation.id });
				} catch {
					json(res, { error: "Invalid JSON" }, 400);
				}
				return true;
			}

			if (
				url.pathname === "/api/editor-annotation" &&
				req.method === "DELETE"
			) {
				const id = url.searchParams.get("id");
				if (!id) {
					json(res, { error: "Missing id parameter" }, 400);
					return true;
				}
				const idx = annotations.findIndex((annotation) => annotation.id === id);
				if (idx !== -1) {
					annotations.splice(idx, 1);
				}
				json(res, { ok: true });
				return true;
			}

			return false;
		},
	};
}
