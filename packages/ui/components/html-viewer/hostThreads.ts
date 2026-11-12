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

export function projectHostThreads(
  threads: readonly HostThread[],
  options?: ProjectHostThreadsOptions,
): Annotation[] {
  return projectHostThreadsCore(threads, options) as unknown as Annotation[];
}
