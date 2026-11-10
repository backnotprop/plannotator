/**
 * Moved to @plannotator/ui (packages/ui/components/inbox-thread/icons.tsx) unchanged, so a
 * host of the shared thread parts draws the same marks. This path re-exports it so every
 * existing import and test keeps working.
 */
export * from '@plannotator/ui/components/inbox-thread/icons';

/**
 * Plannotator's mark as a single-colour glyph: the bold P over its highlight bar, from the classic favicon
 * (`CLASSIC_FAVICON_SVG` in core, without its dark tile), drawn in `currentColor` in a 24 box. The P is solid and
 * the bar a tint of the same colour behind it, cut away around the P so the letter stays clean at 16 px.
 * Decorative (`aria-hidden`); the caller sizes and colours it (`className`).
 */
export function PlannotatorMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" data-plannotator-mark="">
      {/* Scaled about the middle so the P stands as tall as the cube beside it (12 of 16 px). */}
      <g transform="translate(12 12) scale(1.18) translate(-12 -12.2)">
      {/* The highlight bar, in two pieces: left of the stem, and right of it under the bowl. */}
      <path opacity="0.4" d="M3.6 11.2h1.3v6H3.6a1.4 1.4 0 0 1-1.4-1.4v-3.2a1.4 1.4 0 0 1 1.4-1.4ZM10.7 15h2.5a5.6 5.6 0 0 0 4.9-3.8h2.3a1.4 1.4 0 0 1 1.4 1.4v3.2a1.4 1.4 0 0 1-1.4 1.4h-9.7Z" />
      <path fillRule="evenodd" d="M6 4.5h7.1a4.7 4.7 0 0 1 0 9.4H9.6v5.6H6ZM9.6 7.6v3.2h3.1a1.6 1.6 0 0 0 0-3.2Z" />
      </g>
    </svg>
  );
}
