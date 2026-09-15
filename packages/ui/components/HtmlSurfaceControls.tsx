/**
 * Header controls for a raw-HTML or live-app annotation surface: the eye
 * (show/hide the floating tools over the page), the optional refresh, and
 * the pen (Annotate/Interact toggle). Presentation only; every state lives
 * in the host. Each control renders only when its handler is passed, so a
 * read-only document can show the eye without a pen.
 *
 * The markup, data attributes (`data-html-tools-toggle`, `data-html-refresh`,
 * `data-html-annotate-toggle`), aria state and the pixel-stable pen border
 * are the exact ones Plannotator's header shipped with; hosts get the same
 * control, and `labels` overrides the strings without touching the DOM.
 *
 * Each control's description rides the app's `Tooltip` (hover AND
 * focus-visible, theme tokens, portal) instead of a native `title`, with the
 * control's keyboard shortcut rendered under it as keycaps through the
 * shortcut registry's platform-aware formatter — never a hardcoded "Cmd".
 * The strings are the same `labels` values the titles used, so a host's
 * overrides keep working; because `title` no longer supplies the accessible
 * name, each button carries it explicitly (the pen an `aria-label`, the eye
 * its sr-only text, the refresh its existing `aria-label`), and the shortcut
 * is also attached as a persistent `aria-describedby` so it is announced
 * rather than only drawn.
 */
import React from 'react';
import { Tooltip } from './Tooltip';
import { formatShortcutBindingText, formatShortcutBindingTokens } from '../shortcuts/core';
import { htmlAnnotateShortcuts } from '../shortcuts/plan-review/htmlAnnotate.shortcuts';

/** Binding overrides, in the registry's normalized syntax (`Mod+Shift+X`).
 *  `null` renders no shortcut row for that control. Defaults come from the
 *  `html-annotate` scope, so the tooltips can never drift from the chords the
 *  app actually dispatches; `refresh` has no chord and defaults to none. */
export interface HtmlSurfaceControlShortcuts {
  annotate?: string | null;
  tools?: string | null;
  refresh?: string | null;
}

const DEFAULT_HTML_SURFACE_CONTROL_SHORTCUTS: Required<HtmlSurfaceControlShortcuts> = {
  annotate: htmlAnnotateShortcuts.shortcuts.toggleAnnotateMode.bindings[0] ?? null,
  tools: htmlAnnotateShortcuts.shortcuts.toggleTools.bindings[0] ?? null,
  refresh: null,
};

/** Description + keycaps. Two lines, so the tooltip answers both "what does
 *  this do" and "what do I press" without a second hover. */
function ControlTooltip({
  description,
  binding,
  children,
}: {
  description: string;
  binding: string | null;
  children: React.ReactElement;
}) {
  const keys = binding ? formatShortcutBindingTokens(binding) : null;
  return (
    <Tooltip
      side="bottom"
      wide
      content={(
        <span className="flex flex-col gap-1">
          <span>{description}</span>
          {keys && keys.length > 0 && (
            <span className="flex items-center gap-1">
              {keys.map((key, index) => (
                <kbd
                  key={`${key}-${index}`}
                  className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border/60 bg-muted px-1 font-mono text-[10px] leading-none text-foreground/80"
                >
                  {key}
                </kbd>
              ))}
            </span>
          )}
        </span>
      )}
    >
      {children}
    </Tooltip>
  );
}

/** The shortcut as prose for assistive tech ("Cmd+Shift+X"), which keycaps
 *  alone would not announce. */
function ShortcutDescription({ id, binding }: { id: string; binding: string | null }) {
  if (!binding) return null;
  return (
    <span id={id} hidden>
      {`Shortcut: ${formatShortcutBindingText(binding)}`}
    </span>
  );
}

/** String overrides. Every key optional; defaults are Plannotator's strings. */
export interface HtmlSurfaceControlLabels {
  /** Pen tooltip description while Annotate is armed. */
  annotateTitle?: string;
  /** Pen tooltip description while in Interact mode. */
  interactTitle?: string;
  /** Pen aria-label while armed. Default: the armed description. */
  annotateLabel?: string;
  /** Pen aria-label while in Interact mode. Default: the interact description. */
  interactLabel?: string;
  /** Eye tooltip description and screen-reader text while the tools are visible. */
  hideTools?: string;
  /** Eye tooltip description and screen-reader text while the tools are hidden. */
  showTools?: string;
  /** Refresh visible text while idle. */
  refresh?: string;
  /** Refresh visible text while a refresh is in flight. */
  refreshing?: string;
  /** Refresh tooltip description and aria-label while idle. */
  refreshTitle?: string;
  /** Refresh tooltip description and aria-label while a refresh is in flight. */
  refreshingTitle?: string;
}

export const DEFAULT_HTML_SURFACE_CONTROL_LABELS: Required<
  Omit<HtmlSurfaceControlLabels, 'annotateLabel' | 'interactLabel'>
> = {
  annotateTitle: 'Annotate mode: click an element or select text to comment. Esc to interact',
  interactTitle: 'Interact mode: clicks reach the page (text selection still comments). Click to annotate',
  hideTools: 'Hide tools',
  showTools: 'Show tools',
  refresh: 'Refresh',
  refreshing: 'Refreshing',
  refreshTitle: 'Refresh document',
  refreshingTitle: 'Refreshing document',
};

// Stable ids: one HTML surface renders at most one of each control.
const ANNOTATE_SHORTCUT_ID = 'pn-html-annotate-shortcut';
const TOOLS_SHORTCUT_ID = 'pn-html-tools-shortcut';
const REFRESH_SHORTCUT_ID = 'pn-html-refresh-shortcut';

export interface HtmlSurfaceControlsProps {
  /** Whether Annotate is armed (pen pressed). */
  armed: boolean;
  /** Flip Annotate/Interact. The pen renders only when provided. */
  onToggleArmed?: () => void;
  /** Whether the floating tools over the page are hidden (eye-off). */
  toolsHidden?: boolean;
  /** Flip the tools. The eye renders only when provided. */
  onToggleTools?: () => void;
  /** Whether a refresh is offered for this document. The refresh renders
   *  whenever this is true and `onRefresh` is passed, with or without the eye. */
  canRefresh?: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  /** Compact touch shells put these actions in a menu instead: render nothing. */
  compact?: boolean;
  labels?: HtmlSurfaceControlLabels;
  /** Per-control keyboard shortcuts shown in the tooltips. */
  shortcuts?: HtmlSurfaceControlShortcuts;
}

export function HtmlSurfaceControls({
  armed,
  onToggleArmed,
  toolsHidden = false,
  onToggleTools,
  canRefresh = false,
  onRefresh,
  isRefreshing = false,
  compact = false,
  labels,
  shortcuts,
}: HtmlSurfaceControlsProps) {
  if (compact) return null;
  const text = { ...DEFAULT_HTML_SURFACE_CONTROL_LABELS, ...labels };
  const keys = { ...DEFAULT_HTML_SURFACE_CONTROL_SHORTCUTS, ...shortcuts };
  const penDescription = armed ? text.annotateTitle : text.interactTitle;
  // `title` used to carry the pen's accessible name; with the tooltip in its
  // place the name has to be stated, or the pen becomes an unnamed button.
  const penLabel = (armed ? labels?.annotateLabel : labels?.interactLabel) ?? penDescription;
  const toolsDescription = toolsHidden ? text.showTools : text.hideTools;
  const refreshDescription = isRefreshing ? text.refreshingTitle : text.refreshTitle;
  const showRefresh = canRefresh && !!onRefresh;
  return (
    <>
      {/* The refresh and the eye share one group, left of the pen. Each
          renders on its own terms: the refresh whenever it is offered
          (canRefresh + onRefresh), the eye whenever onToggleTools is passed,
          so a host without the tools toggle still gets its refresh.

          Show/hide tools: removes ALL floating chrome (sidebar tongue tabs +
          the comment/attachments cluster) from the DOM, leaving nothing over
          the page. This button is the only way back, so it never hides
          itself. Eye = tools visible, eye-off = hidden. */}
      {(showRefresh || onToggleTools) && (
        <div className="ml-1 flex items-center gap-0.5">
          {showRefresh && (
            <ControlTooltip description={refreshDescription} binding={keys.refresh}>
            <button
              type="button"
              data-html-refresh
              // aria-disabled rather than disabled: a disabled control drops
              // keyboard focus to body when activated. useHtmlRefresh already
              // dedups in-flight requests, so an extra click is harmless.
              onClick={isRefreshing ? undefined : onRefresh}
              aria-disabled={isRefreshing}
              {...(keys.refresh ? { 'aria-describedby': REFRESH_SHORTCUT_ID } : {})}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground aria-disabled:cursor-wait aria-disabled:opacity-70"
              aria-label={refreshDescription}
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
              <span className="hidden sm:inline">{isRefreshing ? text.refreshing : text.refresh}</span>
            </button>
            </ControlTooltip>
          )}
          {showRefresh && <ShortcutDescription id={REFRESH_SHORTCUT_ID} binding={keys.refresh} />}
          {onToggleTools && (
          <ControlTooltip description={toolsDescription} binding={keys.tools}>
          <button
            type="button"
            data-html-tools-toggle
            onClick={onToggleTools}
            aria-pressed={toolsHidden}
            {...(keys.tools ? { 'aria-describedby': TOOLS_SHORTCUT_ID } : {})}
            className="cursor-pointer rounded-md border border-transparent p-1.5 text-xs font-medium text-muted-foreground transition-all hover:bg-muted hover:text-foreground"
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
            <span className="sr-only">{toolsDescription}</span>
          </button>
          </ControlTooltip>
          )}
          {onToggleTools && <ShortcutDescription id={TOOLS_SHORTCUT_ID} binding={keys.tools} />}
        </div>
      )}

      {/* Interact/Annotate toggle. A PEN icon (deliberately not a speech
          bubble: an annotations-panel bubble beside it must stay
          distinguishable at a glance, and so must AI sparkles). Always the
          same icon: armed shows the accent color plus a visible border;
          unarmed is muted with a TRANSPARENT border of the same width, so
          the button's box is pixel-identical in both states. */}
      {onToggleArmed && (
        <ControlTooltip description={penDescription} binding={keys.annotate}>
        <button
          type="button"
          data-html-annotate-toggle
          onClick={onToggleArmed}
          aria-pressed={armed}
          className={`p-1.5 rounded-md border text-xs font-medium transition-all cursor-pointer ${
            armed
              ? 'border-primary/60 bg-primary/15 text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
          aria-label={penLabel}
          {...(keys.annotate ? { 'aria-describedby': ANNOTATE_SHORTCUT_ID } : {})}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.862 4.487zm0 0L19.5 7.125" />
          </svg>
        </button>
        </ControlTooltip>
      )}
      {onToggleArmed && <ShortcutDescription id={ANNOTATE_SHORTCUT_ID} binding={keys.annotate} />}
    </>
  );
}
