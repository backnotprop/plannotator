import { FOCUS_RING } from "../lib/recipes";
import { cn } from "../lib/utils";

/** "1 update" or "N updates". */
export function cardUpdatesWords(count: number): string {
  return `${count} ${count === 1 ? "update" : "updates"}`;
}

/**
 * A quiet pill over a list or grid of cards that has news the viewer has not
 * taken yet: "3 updates · Show". The count is announced politely when it
 * changes, not on every render; nothing moves at rest. With no updates it
 * draws nothing. `onShow` is the host's: usually `settleBatch` with the new order.
 */
export function CardUpdatesPill({ count, onShow }: { readonly count: number; readonly onShow: () => void }) {
  const words = count > 0 ? cardUpdatesWords(count) : "";
  return (
    <>
      <span data-frame-card-updates-live="" aria-live="polite" aria-atomic="true" className="sr-only">
        {words}
      </span>
      {count > 0 && (
        <button
          type="button"
          data-frame-card-updates=""
          onClick={onShow}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-full bg-card px-3 text-[13px] leading-[18px] text-foreground shadow-[0_0_0_1px_var(--frame-card-ring)] hover:bg-frame-hover",
            FOCUS_RING,
          )}
        >
          <span>{words}</span>
          <span aria-hidden="true" className="text-frame-muted-fg">
            ·
          </span>
          <span className="font-medium text-primary">Show</span>
        </button>
      )}
    </>
  );
}
