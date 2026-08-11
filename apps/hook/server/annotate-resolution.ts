/**
 * Annotate target resolution for the direct CLI (`plannotator annotate`).
 *
 * Extracted from the annotate branch of index.ts so the resolution pipeline
 * can be re-run once by the tolerant token fallback (#1182) and unit tested.
 * The behavior of a single resolution pass is unchanged: the same branch
 * order (URL, folder, HTML, document), the same messages, and the same
 * progress lines, emitted through `log` at the same points as before.
 *
 * Failures are returned instead of exiting; the caller maps them onto the
 * existing exit behavior. `notFound` is true only for the "the input named
 * nothing" terminal, which is the sole hook point for the token fallback.
 * Every target-specific failure (unsupported type, oversized file, empty
 * folder, unreachable URL, ambiguous name) keeps `notFound` false so it
 * surfaces verbatim.
 */

import { existsSync, statSync } from "fs";
import path from "path";
import { resolveAtReference, stripAtPrefix } from "@plannotator/shared/at-reference";
import { loadConfig, resolveUseJina } from "@plannotator/shared/config";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import {
  ANNOTATABLE_DOC_REGEX,
  ANNOTATABLE_EXTENSIONS_HINT,
  MAX_ANNOTATABLE_FILE_BYTES,
  hasMarkdownFiles,
  resolveMarkdownFile,
  resolveUserPath,
} from "@plannotator/shared/resolve-file";
import { isConvertedSource, urlToMarkdown } from "@plannotator/shared/url-to-markdown";

export interface AnnotateResolutionSuccess {
  ok: true;
  markdown: string;
  rawHtml?: string;
  absolutePath: string;
  folderPath?: string;
  annotateMode: "annotate" | "annotate-folder";
  sourceInfo?: string;
  sourceConverted: boolean;
  isUrl: boolean;
}

export interface AnnotateResolutionFailure {
  ok: false;
  /** True only when the input resolved to nothing at all. */
  notFound: boolean;
  message: string;
}

export type AnnotateResolutionResult =
  | AnnotateResolutionSuccess
  | AnnotateResolutionFailure;

export async function resolveAnnotateTarget(options: {
  rawFilePath: string;
  projectRoot: string;
  noJina: boolean;
  renderMarkdown: boolean;
  log?: (line: string) => void;
}): Promise<AnnotateResolutionResult> {
  const { rawFilePath, projectRoot, noJina, renderMarkdown } = options;
  const log = options.log ?? ((line: string) => console.error(line));

  // Primary resolution strips the `@` reference marker; rawFilePath is
  // preserved so each branch can fall back to the literal form below
  // (scoped-package-style names).
  const filePath = stripAtPrefix(rawFilePath);

  if (process.env.PLANNOTATOR_DEBUG) {
    log(`[DEBUG] Project root: ${projectRoot}`);
    log(`[DEBUG] File path arg: ${filePath}`);
  }

  // --- URL annotation ---
  const isUrl = /^https?:\/\//i.test(filePath);

  if (isUrl) {
    const useJina = resolveUseJina(noJina, loadConfig());
    log(`Fetching: ${filePath}${useJina ? " (via Jina Reader)" : " (via fetch+Turndown)"}`);
    let markdown: string;
    let sourceConverted: boolean;
    try {
      const result = await urlToMarkdown(filePath, { useJina });
      markdown = result.markdown;
      sourceConverted = isConvertedSource(result.source);
      if (process.env.PLANNOTATOR_DEBUG) {
        log(`[DEBUG] Fetched via ${result.source} (${markdown.length} chars)`);
      }
    } catch (err) {
      return {
        ok: false,
        notFound: false,
        message: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      ok: true,
      markdown,
      absolutePath: filePath, // Use URL as the "path" for display
      annotateMode: "annotate",
      sourceInfo: filePath, // Full URL for source attribution
      sourceConverted,
      isUrl,
    };
  }

  // Folder check with literal-@ fallback for scoped-package-style names.
  const folderCandidate = resolveAtReference(rawFilePath, (c) => {
    try {
      return statSync(resolveUserPath(c, projectRoot)).isDirectory();
    } catch {
      return false;
    }
  });

  if (folderCandidate !== null) {
    const resolvedArg = resolveUserPath(folderCandidate, projectRoot);
    // Folder annotation mode (markdown/plain text/config + HTML files)
    if (!hasMarkdownFiles(resolvedArg, FILE_BROWSER_EXCLUDED, ANNOTATABLE_DOC_REGEX)) {
      return {
        ok: false,
        notFound: false,
        message: `No annotatable files (markdown, plain-text, config, or HTML) found in ${resolvedArg}`,
      };
    }
    log(`Folder: ${resolvedArg}`);
    return {
      ok: true,
      markdown: "",
      absolutePath: resolvedArg,
      folderPath: resolvedArg,
      annotateMode: "annotate-folder",
      sourceConverted: false,
      isUrl,
    };
  }

  // HTML check with the same literal-@ fallback semantics.
  const htmlCandidate = resolveAtReference(rawFilePath, (c) => {
    const abs = resolveUserPath(c, projectRoot);
    return /\.html?$/i.test(abs) && existsSync(abs);
  });

  if (htmlCandidate !== null) {
    const resolvedArg = resolveUserPath(htmlCandidate, projectRoot);
    const htmlFile = Bun.file(resolvedArg);
    const html = await htmlFile.text();
    const renderHtmlForFile = !renderMarkdown;
    let markdown: string;
    let rawHtml: string | undefined;
    let sourceConverted = false;
    if (renderHtmlForFile) {
      rawHtml = html;
      markdown = "";
    } else {
      markdown = htmlToMarkdown(html);
      sourceConverted = true;
    }
    log(`${renderHtmlForFile ? "Raw HTML" : "Converted"}: ${resolvedArg}`);
    return {
      ok: true,
      markdown,
      rawHtml,
      absolutePath: resolvedArg,
      annotateMode: "annotate",
      sourceInfo: path.basename(resolvedArg),
      sourceConverted,
      isUrl,
    };
  }

  // Single markdown/plain-text file annotation mode
  // Strip-first with literal-@ fallback (scoped-package-style names).
  let resolved = resolveMarkdownFile(filePath, projectRoot);
  if (resolved.kind === "not_found" && rawFilePath !== filePath) {
    resolved = resolveMarkdownFile(rawFilePath, projectRoot);
  }

  if (resolved.kind === "ambiguous") {
    return {
      ok: false,
      notFound: false,
      message: [
        `Ambiguous filename "${resolved.input}" — found ${resolved.matches.length} matches:`,
        ...resolved.matches.map((match) => `  ${match}`),
      ].join("\n"),
    };
  }
  if (resolved.kind !== "found") {
    // Check if file exists but has unsupported type
    const resolvedPath = resolveUserPath(resolved.input, projectRoot);
    const fileExists = existsSync(resolvedPath);

    if (fileExists) {
      const ext = path.extname(resolvedPath).toLowerCase();
      return {
        ok: false,
        notFound: false,
        message:
          `File type not supported: ${ext}\n` +
          `Supported types: ${ANNOTATABLE_EXTENSIONS_HINT}\n` +
          `For code review, use: plannotator review [file]`,
      };
    }
    return {
      ok: false,
      notFound: true,
      message: `File not found: ${resolved.input}`,
    };
  }

  const absolutePath = resolved.path;
  if (Bun.file(absolutePath).size > MAX_ANNOTATABLE_FILE_BYTES) {
    return {
      ok: false,
      notFound: false,
      message: `File too large to annotate (max 2MB): ${absolutePath}`,
    };
  }
  const markdown = await Bun.file(absolutePath).text();
  log(`Resolved: ${absolutePath}`);
  return {
    ok: true,
    markdown,
    absolutePath,
    annotateMode: "annotate",
    sourceConverted: false,
    isUrl,
  };
}
