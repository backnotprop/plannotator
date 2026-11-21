import { describe, expect, test } from "bun:test";
import {
	annotateDocumentRenderKind,
	codeDocumentLanguage,
	documentRenderKindForPath,
	isAnnotatableTextPath,
	isDocumentRenderKind,
	normalizeMarkdownExtensions,
	shouldStripFrontmatter,
} from "./annotatable";

const CONFIG_AND_DATA = [
	"config.yaml",
	"ci.YML",
	"package.json",
	"tsconfig.jsonc",
	"settings.json5",
	"pyproject.toml",
	"setup.ini",
	"setup.cfg",
	"nginx.conf",
	"app.properties",
	"rows.csv",
	"rows.tsv",
	"server.log",
	"pom.xml",
	".env.example",
] as const;

describe("config and data files in the annotatable seam", () => {
	test("every config or data extension is annotatable text with the code render kind", () => {
		for (const path of CONFIG_AND_DATA) {
			expect(isAnnotatableTextPath(path)).toBe(true);
			expect(documentRenderKindForPath(`/repo/${path}`)).toBe("code");
		}
	});

	test("markdown, .txt, diagrams and AsciiDoc keep their own kinds", () => {
		expect(documentRenderKindForPath("notes.md")).toBeNull();
		expect(documentRenderKindForPath("notes.txt")).toBeNull();
		expect(documentRenderKindForPath("flow.mmd")).toBe("mermaid");
		expect(documentRenderKindForPath("guide.adoc")).toBe("asciidoc");
		expect(documentRenderKindForPath("config.yaml.bak")).toBeNull();
		// A `.env` the person names renders as a code document, like `.env.example`.
		expect(documentRenderKindForPath(".env")).toBe("code");
		expect(documentRenderKindForPath("app/.env.local")).toBe("code");
	});

	test("isDocumentRenderKind accepts code", () => {
		expect(isDocumentRenderKind("code")).toBe(true);
		expect(isDocumentRenderKind("markdown")).toBe(false);
	});

	test("a code session needs a local file opened as itself", () => {
		expect(annotateDocumentRenderKind({ filePath: "/repo/pyproject.toml" })).toBe("code");
		expect(annotateDocumentRenderKind({ filePath: "https://x.dev/openapi.json" })).toBeNull();
		expect(annotateDocumentRenderKind({ filePath: "/repo", mode: "annotate-folder" })).toBeNull();
	});

	test("each file names its grammar; .cfg and .conf are never guessed", () => {
		expect(codeDocumentLanguage("/repo/ci.YML")).toBe("yaml");
		expect(codeDocumentLanguage("package.json")).toBe("json");
		expect(codeDocumentLanguage("tsconfig.jsonc")).toBe("jsonc");
		expect(codeDocumentLanguage("settings.json5")).toBe("json5");
		expect(codeDocumentLanguage("pyproject.toml")).toBe("toml");
		expect(codeDocumentLanguage("setup.ini")).toBe("ini");
		expect(codeDocumentLanguage("app.properties")).toBe("ini");
		expect(codeDocumentLanguage("pom.xml")).toBe("xml");
		expect(codeDocumentLanguage("rows.csv")).toBe("csv");
		expect(codeDocumentLanguage("rows.tsv")).toBe("tsv");
		expect(codeDocumentLanguage("server.log")).toBe("log");
		expect(codeDocumentLanguage(".env.example")).toBe("dotenv");
		expect(codeDocumentLanguage("setup.cfg")).toBeUndefined();
		expect(codeDocumentLanguage("nginx.conf")).toBeUndefined();
		expect(codeDocumentLanguage(null)).toBeUndefined();
	});

	test("a multi-document YAML keeps its leading --- block", () => {
		expect(shouldStripFrontmatter("k8s.yaml")).toBe(false);
	});

	test("a configured markdown extra cannot claim a code extension", () => {
		// Extras (#1307) are markdown by definition; the built-ins win.
		expect(normalizeMarkdownExtensions([".toml", ".yaml", ".livemd"])).toEqual([".livemd"]);
		expect(documentRenderKindForPath("notebook.livemd")).toBeNull();
	});
});
