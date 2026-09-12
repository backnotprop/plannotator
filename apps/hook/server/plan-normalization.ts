export function normalizePlanText(plan: string): string {
  return plan.replace(/\r\n/g, "\n").trim();
}
