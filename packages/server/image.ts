import { resolve } from "path";

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

const UPLOAD_DIR = "/tmp/plannotator";

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filePath.slice(lastDot + 1).toLowerCase();
}

function hasImageExtension(filePath: string): boolean {
  return ALLOWED_IMAGE_EXTENSIONS.has(getExtension(filePath));
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
