/**
 * Type checks for the usage-counts recorder, checked by `bun run typecheck`
 * (packages/shared/tsconfig.json includes this file; it is never imported).
 * An `@ts-expect-error` that stops erroring fails the typecheck, so these
 * prove a caller can name only a registry event of its own feature, and never
 * one of the two local facts.
 */
import { recordUsageCount } from "./usage-counts";

const deps = { version: undefined };

export function usageCountsTypeChecks(): void {
  recordUsageCount("decisionMode", "opened", deps);
  recordUsageCount("decisionMode", "active_day", deps);
  // @ts-expect-error not an event of the feature
  recordUsageCount("decisionMode", "nope", deps);
  // @ts-expect-error a local fact is never recorded by a caller
  recordUsageCount("decisionMode", "first_day", deps);
  // @ts-expect-error a local fact is never recorded by a caller
  recordUsageCount("decisionMode", "days_last7", deps);
  // @ts-expect-error not a counted feature
  recordUsageCount("editSuggestions", "opened", deps);
  // @ts-expect-error no free text rides along
  recordUsageCount("decisionMode", "opened", "extra");
  // @ts-expect-error the build version is required: a build that sends nowhere records nothing
  recordUsageCount("decisionMode", "opened", {});
}
