import { resolve, join, normalize } from "path";
import { tmpdir } from "os";

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "tiff",
  "tif",
  "avif",
]);

const UPLOAD_DIR = join(tmpdir(), "plannotator");

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filePath.slice(lastDot + 1).toLowerCase();
}

function hasImageExtension(filePath: string): boolean {
  return ALLOWED_IMAGE_EXTENSIONS.has(getExtension(filePath));
}

/**
 * Check whether resolved path is within an allowed root directory
 * (project root or the uploads temp directory).
 */
function isWithinAllowedRoot(resolved: string): boolean {
  const normalizedResolved = normalize(resolved);
  const projectRoot = normalize(process.cwd());
  const uploadDir = normalize(UPLOAD_DIR);

  return (
    normalizedResolved === projectRoot ||
    normalizedResolved.startsWith(projectRoot + "/") ||
    normalizedResolved === uploadDir ||
    normalizedResolved.startsWith(uploadDir + "/")
  );
}

export function validateImagePath(rawPath: string): {
  valid: boolean;
  resolved: string;
  error?: string;
} {
  const resolved = resolve(rawPath);

  if (!hasImageExtension(resolved)) {
    return {
      valid: false,
      resolved,
      error: "Path does not point to a supported image file",
    };
  }

  if (!isWithinAllowedRoot(resolved)) {
    return {
      valid: false,
      resolved,
      error: "Access denied: path is outside project root",
    };
  }

  return { valid: true, resolved };
}

export function validateUploadExtension(fileName: string): {
  valid: boolean;
  ext: string;
  error?: string;
} {
  const ext = getExtension(fileName) || "png";

  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      ext,
      error: `File extension ".${ext}" is not a supported image type`,
    };
  }

  return { valid: true, ext };
}

export { UPLOAD_DIR };
