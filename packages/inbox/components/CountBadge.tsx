export function countBadgeText(count: number): string {
  return count > 9 ? '9+' : String(count);
}

export function CountBadge({ count, data }: { count: number; data?: Record<`data-${string}`, string> }) {
  const text = countBadgeText(count);
  return (
    <span className="ib-cnt" aria-hidden="true" data-wide={text.length > 1 ? '' : undefined} {...data}>
      {text}
    </span>
  );
}
