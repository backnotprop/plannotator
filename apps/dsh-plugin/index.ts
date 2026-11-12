import type { DshInboxContext } from "./inbox";
import type { DshContext } from "./plan-review";
import { applyPlannotator } from "./plugin";

export const name = "plannotator";

export function apply(ctx: DshContext & Partial<Pick<DshInboxContext, "inject">>, config?: unknown): Promise<void> {
  return applyPlannotator(ctx, config);
}
