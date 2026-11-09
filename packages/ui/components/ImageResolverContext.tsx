import { createContext, useContext } from "react";

/**
 * What a host makes of an image a document references (`![shot](img/a.png)`,
 * or an `<img src>` in a raw HTML block):
 *
 * - `src`: load the image from this URL instead of the default resolution
 *   (with `width`, laid out at that width as the original would be).
 * - `unavailable`: draw a small inert placeholder (the alt text, `title` as
 *   its tooltip) instead of an `<img>`, so nothing is fetched.
 * - `null` from the resolver: the renderer's default for that image.
 */
export type ImageResolution =
  | {
      kind: "src";
      src: string;
      /**
       * The picture's own width in pixels, when `src` serves a smaller copy
       * of it (the Plannotator Inbox's `?w=`, for a big screenshot drawn at
       * the width of a message): the `<img>` gets it as its `width`, so it is
       * laid out exactly as the original would be (still at most 100% wide),
       * while the browser decodes only the copy.
       */
      width?: number;
    }
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

/** Trusted hosts may preserve videos while resolving only image URLs. */
export const PreserveResolvedVideosContext = createContext(false);

/**
 * With a resolver, keep `<picture><source>` and `<img srcset>` in raw HTML and
 * pass each `srcset` candidate URL through the resolver, instead of dropping
 * them (a candidate it calls `unavailable` drops that `srcset`). Lets a
 * README-style dark-mode `<source media="(prefers-color-scheme: dark)">` keep
 * working. Absent (false), they are dropped as before.
 */
export const ResolvedResponsiveImagesContext = createContext(false);
