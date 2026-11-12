export const PI_WIDGET_MAX_LINES = 10;

export function checklistWindow<T extends { completed: boolean }>(
	items: readonly T[],
	maxLines: number = PI_WIDGET_MAX_LINES,
): T[] {
	if (items.length <= maxLines) return [...items];
	const next = items.findIndex((item) => !item.completed);
	const end = next === -1 ? items.length : Math.max(maxLines, next + 1);
	return items.slice(end - maxLines, end);
}
