/**
 * Human-readable relative timestamps for the review UI.
 *
 * Used by AITab (chat message timestamps) and ReviewSidebar (annotation timestamps).
 * Returns compact strings: "now", "3m", "2h", "5d", or "Mar 15" for older dates.
 */
export function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;

  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
