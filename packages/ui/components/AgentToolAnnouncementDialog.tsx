import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { agentToolHostName } from '../utils/agentToolSetting';

/**
 * One-time offer to turn on the `plannotator` agent tool on Pi and OpenCode 2,
 * where it is off by default. Question first ("Do you use Plannotator as a
 * skill?"), two example requests, one line of why, the cost, and two buttons,
 * under a small diagram of the round trip (the agent opens a review right
 * away, keeps working, your feedback comes back). Same shell as the other
 * first-run announcements (portal, z-[100], hand-rolled Escape + Tab wrap +
 * focus restore, backdrop dismiss, capture-phase keydown that swallows
 * Mod+Enter so a keystroke aimed here cannot approve a plan or post a review
 * behind it).
 *
 * Unlike those, it collects a decision, so it never dismisses itself while a
 * save is in flight, and it reports the outcome in place: a failed save shows
 * the server's reason and keeps both buttons; a successful one says when the
 * tool arrives and offers Done.
 *
 * LAST in each app's first-run dialog chain; the Apps gate rendering through
 * agentToolAnnouncementEligible and useFirstRunAnnouncementWindow.
 */

export type AgentToolOfferHost = 'pi' | 'opencode';

interface AgentToolAnnouncementDialogProps {
  readonly isOpen: boolean;
  /** The session's host; names the agent and when the change applies. */
  readonly host: AgentToolOfferHost;
  /**
   * "Yes, turn it on": writes the setting (POST /api/config `{ agentTool: true }`).
   * Rejects with an Error whose message is shown. The App marks the offer
   * seen when it resolves.
   */
  readonly onTurnOn: () => Promise<void>;
  /** The decline button ("No, I’ll just use slash commands"), Escape, the backdrop and Done: marks the offer seen and closes it. */
  readonly onDismiss: () => void;
}

type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'failed'; readonly message: string };

const SECONDARY_BUTTON_CLASS =
  'inline-flex min-h-9 items-center gap-2 rounded-lg border border-border bg-surface-0/40 px-3 text-sm font-medium text-foreground outline-none transition-colors motion-reduce:transition-none hover:bg-surface-1/70 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50';

const PRIMARY_BUTTON_CLASS =
  'min-h-9 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground outline-none transition-opacity motion-reduce:transition-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50';

export function AgentToolAnnouncementDialog({
  isOpen,
  host,
  onTurnOn,
  onDismiss,
}: AgentToolAnnouncementDialogProps) {
  const notNowRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onDismissRef = useRef(onDismiss);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const saveRef = useRef(save);
  saveRef.current = save;
  const mountedRef = useRef(true);
  const agent = agentToolHostName(host);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Never closed mid-save: the outcome has to be shown.
  const dismiss = useCallback(() => {
    if (saveRef.current.kind === 'saving') return;
    onDismissRef.current();
  }, []);

  const turnOn = useCallback(async () => {
    if (saveRef.current.kind === 'saving' || saveRef.current.kind === 'saved') return;
    setSave({ kind: 'saving' });
    try {
      await onTurnOn();
      if (mountedRef.current) setSave({ kind: 'saved' });
    } catch (error) {
      if (!mountedRef.current) return;
      setSave({
        kind: 'failed',
        message: error instanceof Error && error.message ? error.message : 'Could not save the setting.',
      });
    }
  }, [onTurnOn]);

  // Focus follows the outcome: Done once saved.
  useEffect(() => {
    if (save.kind === 'saved') doneRef.current?.focus();
  }, [save.kind]);

  useEffect(() => {
    if (!isOpen) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    // The decline button takes focus, so a stray Enter or Space never changes a setting.
    notNowRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      // Both apps submit their decision on Mod+Enter from a window-level
      // handler; swallowing it here on the capture phase keeps a keystroke
      // aimed at this dialog from approving a plan or posting a review.
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = document.querySelector<HTMLElement>('[data-agent-tool-announcement-dialog]');
      const focusable = Array.from(
        dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
          ?? [],
      ).filter((element) => element.getAttribute('tabindex') !== '-1');
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isOpen, dismiss]);

  if (!isOpen) return null;

  const saving = save.kind === 'saving';
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div
        data-agent-tool-announcement-dialog
        data-agent-tool-host={host}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-tool-announcement-title"
        aria-describedby="agent-tool-announcement-description"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <style>{DIALOG_LAYOUT_CSS}</style>
        <div className="pn-ato-graphic shrink-0 border-b border-border px-4 py-3" aria-hidden="true">
          <RoundTripGraphic agent={agent} />
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          <h2 id="agent-tool-announcement-title" className="text-balance text-xl font-semibold tracking-tight sm:text-2xl">
            Do you use Plannotator as a skill?
          </h2>
          <div id="agent-tool-announcement-description">
            <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
              Like asking {agent} to &ldquo;use Plannotator to show me the HTML plan&rdquo; or &ldquo;open a
              Plannotator code review&rdquo;.
            </p>
            <p className="mt-3 text-pretty text-sm leading-relaxed text-foreground">
              If so, turn on the Plannotator tool. Those requests then open right away while {agent} keeps
              working, and your feedback comes back as a message.
            </p>
          </div>
          <p className="mt-3 text-pretty text-xs leading-relaxed text-muted-foreground" data-agent-tool-cost>
            Adds about 780 tokens to each request.{save.kind === 'saved' ? '' : ` ${startsLine(host)}`}
          </p>

          <div className="mt-5 flex flex-col gap-3">
            {save.kind === 'saved' ? (
              <p
                role="status"
                data-agent-tool-status="saved"
                className="inline-flex min-w-0 items-center gap-2 text-sm text-foreground"
              >
                <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
                Turned on. {startsLine(host)}
              </p>
            ) : save.kind === 'failed' ? (
              <p
                role="alert"
                data-agent-tool-status="failed"
                className="inline-flex min-w-0 items-center gap-2 text-sm text-destructive"
              >
                <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
                {save.message}
              </p>
            ) : null}

            {/* Stacks full-width below sm (secondary first, so focus order matches reading order); one row from sm. */}
            <div className="pn-ato-actions">
              {save.kind === 'saved' ? (
                <button
                  ref={doneRef}
                  type="button"
                  onClick={() => onDismissRef.current()}
                  className={`${PRIMARY_BUTTON_CLASS} w-full sm:w-auto`}
                >
                  Done
                </button>
              ) : (
                <>
                  <button
                    ref={notNowRef}
                    type="button"
                    onClick={dismiss}
                    disabled={saving}
                    data-agent-tool-not-now
                    className={`${SECONDARY_BUTTON_CLASS} w-full justify-center text-balance py-1.5 text-center sm:w-auto`}
                  >
                    No, I&rsquo;ll just use slash commands
                  </button>
                  <button
                    type="button"
                    onClick={() => void turnOn()}
                    disabled={saving}
                    aria-busy={saving}
                    data-agent-tool-turn-on
                    className={`${PRIMARY_BUTTON_CLASS} w-full sm:w-auto`}
                  >
                    {saving ? 'Turning on…' : save.kind === 'failed' ? 'Try again' : 'Yes, turn it on'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/*
 * Layout rules, the graphic band tint and the graphic colors are plain CSS (theme
 * tokens through var()) rather than Tailwind utilities on purpose: this file
 * is scanned by the review stylesheet, which the portable guides.show viewer
 * shares, and utilities used nowhere else would change the pinned viewer CSS
 * for a dialog the viewer never renders. Same result as the approved markup:
 * the graphic hides below 420px; the buttons stack full-width below `sm`
 * (40rem) and sit in one right-aligned row from it.
 */
const DIALOG_LAYOUT_CSS = `
.pn-ato-graphic { display: none; background-color: color-mix(in oklab, var(--muted) 45%, transparent); }
@media (min-width: 420px) { .pn-ato-graphic { display: block; } }
.pn-ato-actions { display: flex; flex-direction: column; gap: 0.5rem; }
@media (min-width: 40rem) {
  .pn-ato-actions { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
}
`;

/** When the change applies on each host; part of the small print and the saved status. */
function startsLine(host: AgentToolOfferHost): string {
  return host === 'opencode' ? 'Starts the next time OpenCode starts.' : 'Starts with your next Pi session.';
}

/*
 * The round trip, as inline SVG painted only from theme tokens (var(--token)
 * values from theme.css), so it follows every palette in light and dark.
 * aria-hidden: the copy beside it carries the whole meaning.
 *
 * Motion, in one sentence: your feedback travelling back to the agent is what
 * the tool adds, and drawing that one arrow once shows the direction the
 * static picture only implies. Runs once on mount (900ms draw, then a 200ms
 * fade of its head and label), never loops, and is off under
 * prefers-reduced-motion, where the resting frame is the final one.
 */
const ROUND_TRIP_MOTION_CSS = `
.pn-ato-return { stroke-dasharray: 1; stroke-dashoffset: 0; animation: pn-ato-draw 900ms cubic-bezier(0.23, 1, 0.32, 1) 300ms both; }
.pn-ato-return-head, .pn-ato-return-label { animation: pn-ato-fade 200ms ease-out 1050ms both; }
@keyframes pn-ato-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes pn-ato-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .pn-ato-return, .pn-ato-return-head, .pn-ato-return-label { animation: none; }
}
`;

function RoundTripGraphic({ agent }: { agent: string }) {
  return (
    <svg viewBox="0 0 480 176" className="mx-auto block h-auto w-full font-sans" style={{ maxWidth: 460 }} focusable="false">
      <style>{ROUND_TRIP_MOTION_CSS}</style>

      {/* The agent: a terminal tile */}
      <g transform="translate(92 52)">
        <rect x="0.75" y="0.75" width="54.5" height="54.5" rx="12" style={{ fill: 'var(--card)', stroke: 'var(--border)' }} strokeWidth="1.5" />
        <path d="M17 21 L25 28 L17 35" style={{ fill: 'none', stroke: 'var(--primary)' }} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="29" y="33" width="11" height="3" rx="1.5" style={{ fill: 'var(--primary)' }} />
      </g>
      <text x={120} y={140} textAnchor="middle" fontSize="13" fontWeight="600" style={{ fill: 'var(--foreground)' }}>
        {agent} <tspan fontWeight="400" style={{ fill: 'var(--muted-foreground)' }}>keeps working</tspan>
      </text>

      {/* Plannotator: a document with one highlighted, commented line */}
      <g transform="translate(318 38)">
        <rect x="0.75" y="0.75" width="66.5" height="82.5" rx="10" style={{ fill: 'var(--card)', stroke: 'var(--border)' }} strokeWidth="1.5" />
        <rect x="12" y="15" width="30.8" height="4" rx="2" style={{ fill: 'var(--foreground)' }} fillOpacity="0.55" />
        <rect x="12" y="29" width="44" height="3" rx="1.5" style={{ fill: 'var(--muted-foreground)' }} fillOpacity="0.45" />
        <rect x="9" y="38" width="50" height="11" rx="3" style={{ fill: 'var(--accent)' }} fillOpacity="0.28" />
        <rect x="12" y="42" width="36.1" height="3" rx="1.5" style={{ fill: 'var(--foreground)' }} fillOpacity="0.6" />
        <rect x="12" y="56" width="39.6" height="3" rx="1.5" style={{ fill: 'var(--muted-foreground)' }} fillOpacity="0.45" />
        <rect x="12" y="66" width="24.2" height="3" rx="1.5" style={{ fill: 'var(--muted-foreground)' }} fillOpacity="0.45" />
        <circle cx="64" cy="43" r="7" style={{ fill: 'var(--accent)', stroke: 'var(--card)' }} strokeWidth="2" />
      </g>
      <text x={352} y={140} textAnchor="middle" fontSize="13" fontWeight="600" style={{ fill: 'var(--foreground)' }}>Plannotator</text>

      {/* opens right away */}
      <path d="M152 64 Q 236 16 310 56" style={{ fill: 'none', stroke: 'var(--muted-foreground)' }} strokeWidth="1.75" strokeLinecap="round" />
      <path d="M302.5 47.5 L311 56.5 L299 59" style={{ fill: 'none', stroke: 'var(--muted-foreground)' }} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <text x={232} y={28} textAnchor="middle" fontSize="12" style={{ fill: 'var(--muted-foreground)' }}>opens right away</text>

      {/* your feedback comes back */}
      <path d="M310 106 Q 236 150 152 98" pathLength={1} className="pn-ato-return" style={{ fill: 'none', stroke: 'var(--primary)' }} strokeWidth="2.25" strokeLinecap="round" />
      <path d="M153 112 L151.5 98.5 L164.5 100" className="pn-ato-return-head" style={{ fill: 'none', stroke: 'var(--primary)' }} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
      <text x={236} y={166} textAnchor="middle" fontSize="12" fontWeight="600" className="pn-ato-return-label" style={{ fill: 'var(--primary)' }}>your feedback, as a message</text>
    </svg>
  );
}
