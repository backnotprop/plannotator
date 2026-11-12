import { existsSync, statSync } from "fs";
import path from "path";
import { resolveAtReference, stripAtPrefix } from "@plannotator/shared/at-reference";
import { loadConfig, resolveUseJina } from "@plannotator/shared/config";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import {
  buildAnnotatableDocRegex,
  buildAnnotatableExtensionsHint,
} from "@plannotator/shared/annotatable";
import {
  getExtraMarkdownExtensions,
  MAX_ANNOTATABLE_FILE_BYTES,
  hasMarkdownFiles,
  resolveMarkdownFile,
  resolveUserPath,
} from "@plannotator/shared/resolve-file";
import { isConvertedSource, urlToMarkdown } from "@plannotator/shared/url-to-markdown";
import { isLoopbackHostname } from "@plannotator/server/live-proxy";
import type { AnnotateBundleFile } from "@plannotator/shared/annotate-bundle";
import {
  LIVE_APP_REQUIRES_HTTP_MESSAGE,
  LIVE_APP_REQUIRES_LOOPBACK_MESSAGE,
  LIVE_APP_REQUIRES_URL_MESSAGE,
  buildForceAppFailureMessage,
  buildLivePlannotatorFallbackNotice,
  buildLiveProbeFallbackNotice,
  classifyLiveAppCandidate,
  probeLiveAppTarget,
} from "@plannotator/shared/live-probe";
import { listPlannotatorServerPorts } from "@plannotator/shared/plannotator-ports";

export interface AnnotateResolutionSuccess {
  ok: true;
  markdown: string;
  rawHtml?: string;
  absolutePath: string;
  folderPath?: string;
  annotateMode: "annotate" | "annotate-folder" | "annotate-bundle";
  bundleFiles?: AnnotateBundleFile[];
  sourceInfo?: string;
  sourceConverted: boolean;
  isUrl: boolean;
  liveApp?: boolean;
}

export interface AnnotateResolutionFailure {
  ok: false;
  notFound: boolean;
  message: string;
}

export type AnnotateResolutionResult =
  | AnnotateResolutionSuccess
  | AnnotateResolutionFailure;

export { isLoopbackHostname };

export async function resolveAnnotateTarget(options: {
  rawFilePath: string;
  projectRoot: string;
  noJina: boolean;
  renderMarkdown: boolean;
  extraMarkdownExtensions?: readonly string[];
  forceApp?: boolean;
  forceStatic?: boolean;
  log?: (line: string) => void;
}): Promise<AnnotateResolutionResult> {
  const { rawFilePath, projectRoot, noJina, renderMarkdown, forceApp = false, forceStatic = false } = options;
  const extraMarkdownExtensions =
    options.extraMarkdownExtensions ?? getExtraMarkdownExtensions();
  const log = options.log ?? ((line: string) => console.error(line));

  const filePath = stripAtPrefix(rawFilePath);

  if (process.env.PLANNOTATOR_DEBUG) {
    log(`[DEBUG] Project root: ${projectRoot}`);
    log(`[DEBUG] File path arg: ${filePath}`);
  }

  const isUrl = /^https?:\/\//i.test(filePath);

  if (!isUrl && forceApp) {
    return {
      ok: false,
      notFound: false,
      message: LIVE_APP_REQUIRES_URL_MESSAGE,
    };
  }

  if (isUrl) {
    const { parsed: parsedUrl, loopback } = classifyLiveAppCandidate(filePath);

    if (forceApp && !loopback) {
      return {
        ok: false,
        notFound: false,
        message: LIVE_APP_REQUIRES_LOOPBACK_MESSAGE,
      };
    }
    if (forceApp && parsedUrl?.protocol === "https:") {
      return {
        ok: false,
        notFound: false,
        message: LIVE_APP_REQUIRES_HTTP_MESSAGE,
      };
    }

    if (loopback && parsedUrl?.protocol === "http:" && !forceStatic) {
      const probe = await probeLiveAppTarget(filePath, parsedUrl, fetch, {
        plannotatorPorts: listPlannotatorServerPorts(),
      });
      if (probe.liveEligible) {
        return {
          ok: true,
          markdown: "",
          absolutePath: filePath,
          annotateMode: "annotate",
          liveApp: true,
          sourceInfo: filePath,
          sourceConverted: false,
          isUrl,
        };
      }
      if (forceApp) {
        return {
          ok: false,
          notFound: false,
          message: buildForceAppFailureMessage(filePath, probe),
        };
      }
      if (probe.plannotator) {
        log(buildLivePlannotatorFallbackNotice(filePath));
      } else if (probe.probeError !== null) {
        log(buildLiveProbeFallbackNotice(filePath, probe.probeError));
      }
    }

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
      absolutePath: filePath,
      annotateMode: "annotate",
      sourceInfo: filePath,
      sourceConverted,
      isUrl,
    };
  }

  const folderCandidate = resolveAtReference(rawFilePath, (c) => {
    try {
      return statSync(resolveUserPath(c, projectRoot)).isDirectory();
    } catch {
      return false;
    }
  });

  if (folderCandidate !== null) {
    const resolvedArg = resolveUserPath(folderCandidate, projectRoot);
    if (!hasMarkdownFiles(resolvedArg, FILE_BROWSER_EXCLUDED, buildAnnotatableDocRegex(extraMarkdownExtensions))) {
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

  let resolved = resolveMarkdownFile(filePath, projectRoot, { extraMarkdownExtensions });
  if (resolved.kind === "not_found" && rawFilePath !== filePath) {
    resolved = resolveMarkdownFile(rawFilePath, projectRoot, { extraMarkdownExtensions });
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
    const resolvedPath = resolveUserPath(resolved.input, projectRoot);
    const fileExists = existsSync(resolvedPath);

    if (fileExists) {
      const ext = path.extname(resolvedPath).toLowerCase();
      return {
        ok: false,
        notFound: false,
        message:
          `File type not supported: ${ext}\n` +
          `Supported types: ${buildAnnotatableExtensionsHint(extraMarkdownExtensions)}\n` +
          `For code review, use: plannotator review [DIRECTORY]`,
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
