/**
 * Host-side helpers for the raw-HTML viewer, re-exported from
 * `@plannotator/core/html-anchor` with the package's `Annotation` type.
 *
 * `projectHostThreads` turns a host's stored rows into the `annotations`
 * prop (output order == marker numbering); `buildPersistedHtmlAnchor` trims a
 * composed comment's anchor to a bounded record the host can persist. Both
 * are pure and dependency-free (they live in `@plannotator/core`).
 */
import {
  projectHostThreads as projectHostThreadsCore,
  type HostThread,
  type ProjectHostThreadsOptions,
} from "@plannotator/core/html-anchor";
import type { Annotation } from "../../types";

export {
  buildPersistedHtmlAnchor,
  type BuildPersistedHtmlAnchorOptions,
  type HostThread,
  type PersistedHtmlAnchor,
  type PersistedHtmlAnchorResult,
  type ProjectHostThreadsOptions,
} from "@plannotator/core/html-anchor";

/**
 * Project stored host rows onto the viewer's `annotations` prop, in the
 * host's order (which becomes the marker numbering). See the core function
 * for the projection rules; the `type` literals it emits are the string
 * values of `AnnotationType`, so the cast below is representation-exact.
 */
export function projectHostThreads(
  threads: readonly HostThread[],
  options?: ProjectHostThreadsOptions,
): Annotation[] {
  return projectHostThreadsCore(threads, options) as unknown as Annotation[];
}
