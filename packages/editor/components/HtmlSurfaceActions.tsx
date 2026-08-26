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
          data-html-refresh
          // aria-disabled rather than disabled: a disabled control drops
          // keyboard focus to body when activated. useHtmlRefresh already
          // dedups in-flight requests, so an extra click is harmless.
          onClick={isRefreshing ? undefined : onRefresh}
          aria-disabled={isRefreshing}
          className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground aria-disabled:cursor-wait aria-disabled:opacity-70"
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
        data-html-tools-toggle
        onClick={onToggleTools}
        aria-pressed={toolsHidden}
        className="cursor-pointer rounded-md border border-transparent p-1.5 text-xs font-medium text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
        title={toolsHidden ? 'Show tools' : 'Hide tools'}
      >
        {toolsHidden ? (
          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
          </svg>
        ) : (
          <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        )}
        <span className="sr-only">{toolsHidden ? 'Show tools' : 'Hide tools'}</span>
      </button>
    </div>
  );
}
