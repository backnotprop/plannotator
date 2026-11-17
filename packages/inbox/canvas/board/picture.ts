/**
 * A canvas's picture (PNG) without mounting it: the agent's `canvas read --png` and a message's preview card.
 * Lazy, like CanvasBoard: it imports Excalidraw.
 */
import { exportToBlob, restoreElements } from "@excalidraw/excalidraw";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { CanvasElement } from "@plannotator/core/canvas-scene";

export async function canvasPicture(elements: readonly CanvasElement[], files: Record<string, { dataURL: string; mimeType: string }>): Promise<Blob | null> {
  const live = restoreElements(elements as unknown as ExcalidrawElement[], null, { refreshDimensions: false, repairBindings: true }).filter((e) => !e.isDeleted);
  if (!live.length) return null;
  const binary: Record<string, BinaryFileData> = {};
  for (const [id, f] of Object.entries(files)) {
    binary[id] = { id: id as BinaryFileData["id"], dataURL: f.dataURL as BinaryFileData["dataURL"], mimeType: f.mimeType as BinaryFileData["mimeType"], created: 0 };
  }
  return exportToBlob({
    elements: live,
    files: binary,
    mimeType: "image/png",
    appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
    exportPadding: 24,
    maxWidthOrHeight: 1600,
  });
}

/** A blob as a data: URL (the picture route takes one). */
export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** A picture by URL, as Excalidraw's file data. */
export async function fileData(url: string, mimeType: string): Promise<{ dataURL: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return { dataURL: await blobDataUrl(blob), mimeType: mimeType || blob.type || "image/png" };
  } catch {
    return null;
  }
}
