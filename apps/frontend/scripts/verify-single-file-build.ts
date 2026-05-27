import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

const distDir = join(import.meta.dirname, "..", "dist");
const indexPath = join(distDir, "index.html");

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

if (!existsSync(indexPath)) {
  throw new Error("Expected apps/debug-frontend/dist/index.html to exist after build.");
}

const html = readFileSync(indexPath, "utf-8");

const outputFiles = listFiles(distDir)
  .map((file) => relative(distDir, file))
  .sort();
const extraFiles = outputFiles.filter((file) => file !== "index.html");

if (extraFiles.length > 0) {
  throw new Error(
    `Frontend daemon shell build must be single-file; found outputs: ${extraFiles.join(", ")}`,
  );
}

const htmlWithoutInlineCode = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "<script></script>")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "<style></style>");

const externalScriptPattern = /<script\b[^>]*\bsrc=["'][^"']+["']/i;
const externalLinkPatterns = [
  /<link\b[^>]*\brel=["'](?:stylesheet|modulepreload|preload)["'][^>]*\bhref=["'][^"']+["']/i,
  /<link\b[^>]*\bhref=["'][^"']+["'][^>]*\brel=["'](?:stylesheet|modulepreload|preload)["']/i,
];

if (
  externalScriptPattern.test(html) ||
  externalLinkPatterns.some((pattern) => pattern.test(htmlWithoutInlineCode))
) {
  throw new Error("Frontend daemon shell build must inline scripts and styles.");
}

console.log("Verified single-file frontend shell build.");
