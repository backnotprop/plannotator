import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath, posix as pathPosix } from "node:path";
import {
  htmlAssetContentType,
  rewriteCssAssetReferences,
  rewriteHtmlAssetReferences,
} from "./html-assets";

export const MAX_HTML_ASSET_BYTES = 50 * 1024 * 1024;

export function inlineHtmlLocalAssets(html: string, htmlFilePath: string): string {
  if (/^https?:\/\//i.test(htmlFilePath)) return html;

  try {
    const root = dirname(resolvePath(htmlFilePath));
    const activeCss = new Set<string>();

    const dataUrlFor = (assetPath: string): string | null => {
      try {
        const contentType = htmlAssetContentType(assetPath);
        if (!contentType) return null;

        const resolved = resolvePath(root, assetPath);
        if (!isWithinDirectory(resolved, root)) return null;
        if (!existsSync(resolved)) return null;

        const stat = statSync(resolved);
        if (!stat.isFile() || stat.size > MAX_HTML_ASSET_BYTES) return null;

        let bytes = readFileSync(resolved);
        if (contentType.startsWith("text/css") && !activeCss.has(assetPath)) {
          activeCss.add(assetPath);
          try {
            const cssBase = pathPosix.dirname(assetPath);
            const rewrittenCss = rewriteCssAssetReferences(
              bytes.toString("utf-8"),
              dataUrlFor,
              cssBase === "." ? "" : cssBase,
            );
            bytes = Buffer.from(rewrittenCss, "utf-8");
          } finally {
            activeCss.delete(assetPath);
          }
        }

        return `data:${contentType.replace(/;\s*/g, ";")};base64,${Buffer.from(bytes).toString("base64")}`;
      } catch {
        return null;
      }
    };

    return rewriteHtmlAssetReferences(html, dataUrlFor);
  } catch {
    return html;
  }
}

function isWithinDirectory(filePath: string, root: string): boolean {
  const resolved = resolvePath(filePath);
  const resolvedRoot = resolvePath(root);
  const rel = relative(resolvedRoot, resolved);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
