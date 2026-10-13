import { createContext, useContext } from "react";

/**
 * What a host makes of an image a document references (`![shot](img/a.png)`,
 * or an `<img src>` in a raw HTML block):
 *
 * - `src`: load the image from this URL instead of the default resolution.
 * - `unavailable`: draw a small inert placeholder (the alt text, `title` as
 *   its tooltip) instead of an `<img>`, so nothing is fetched.
 * - `null` from the resolver: the renderer's default for that image.
 */
export type ImageResolution =
  | { kind: "src"; src: string }
  | { kind: "unavailable"; title: string };

/** Called with the image source exactly as the document wrote it. */
export type ImageResolver = (src: string) => ImageResolution | null;

/**
 * Provided by `RenderedMarkdown` from its optional `resolveImage` prop.
 * Absent (null), every image renders exactly as it always has.
 */
export const ImageResolverContext = createContext<ImageResolver | null>(null);

export function useImageResolver(): ImageResolver | null {
  return useContext(ImageResolverContext);
}

/** Classes for the inert placeholder an `unavailable` image renders as. */
export const UNAVAILABLE_IMAGE_CLASS =
  "inline-flex items-center gap-1 my-1 rounded border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground";
