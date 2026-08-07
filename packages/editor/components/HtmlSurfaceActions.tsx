interface HtmlSurfaceActionsProps {
  canRefresh: boolean;
  isRefreshing: boolean;
  toolsHidden: boolean;
  onRefresh: () => void;
  onToggleTools: () => void;
}

export function HtmlSurfaceActions({
  canRefresh,
  isRefreshing,
  toolsHidden,
  onRefresh,
  onToggleTools,
}: HtmlSurfaceActionsProps) {
  return (
    <div className="ml-1 flex items-center gap-0.5">
      {canRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait disabled:opacity-70"
          title={isRefreshing ? 'Refreshing HTML from disk' : 'Refresh HTML from disk'}
          aria-label={isRefreshing ? 'Refreshing HTML from disk' : 'Refresh HTML from disk'}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
          >
            <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5" />
            <path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
          </svg>
          <span className="hidden sm:inline">{isRefreshing ? 'Refreshing' : 'Refresh'}</span>
        </button>
      )}
      <button
        type="button"
        onClick={onToggleTools}
        className="cursor-pointer rounded px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        title={toolsHidden ? 'Show annotation tools' : 'Hide annotation tools'}
      >
        {toolsHidden ? 'Show tools' : 'Hide tools'}
      </button>
    </div>
  );
}
