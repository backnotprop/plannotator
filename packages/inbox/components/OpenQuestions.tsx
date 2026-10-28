import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { Menu } from '@base-ui/react/menu';
import { formatCount, whenTime } from '../format';
import { Icon } from '../icons';
import {
  openQuestionPlaceWords,
  openQuestionState,
  openQuestionsHeading,
  openQuestionsLabel,
  openQuestionSkippable,
  openQuestionSkipped,
  skipAllCandidates,
  skipSelection,
  type OpenQuestion,
  type OpenQuestionPlace,
  type OpenQuestionsNoun,
} from '../openQuestions';
import { Tip } from './Tip';
import { pickWords } from './ReplacedQuestion';
import { decideThreadLabel } from '../decisions/entry';
import { drawOpenQuestionsForm, fitFootRow, footFitCandidates, laidOutChildren, openQuestionsFormText, type FootFit, type OpenQuestionsLabelForm } from '../footFit';

/** What "Skip…" says on hover (and as its description): it is not sent now. */
const SKIP_MODE_TIP = 'Choose questions to skip. Skips ride your next Send.';

/** The Re-ask item at the list's foot (owner, 2026-10-23): what the foot's Re-ask button did. */
export interface OpenQuestionsReask {
  /** "Re-ask in one new message" / "Re-ask in a new message". */
  label: string;
  /** What pressing it does (the old button's tooltip). */
  tooltip: string;
  /** A Re-ask is being sent: the item is disabled. */
  busy: boolean;
  onReask: () => void;
}

/**
 * Decision mode's one way in (experimental, approval "inbox-decision-mode",
 * thread only since the owner's 2026-10-27 call): "Decide these N", the
 * list's first row. The caller passes it only while decision mode is on and
 * two or more of this thread's decisions wait (`decideEntryShown`).
 */
export interface OpenQuestionsDecide {
  /** The thread's decisions in the queue (the projection's, for this thread). */
  count: number;
  onDecide: () => void;
}

export interface OpenQuestionsButtonProps {
  questions: readonly OpenQuestion[];
  /**
   * Shown with no question listed (only action items wait, and Re-ask is
   * offered): the button counts the open action items instead.
   */
  actions?: number;
  /** Re-ask, when it is offered: one item at the list's foot. */
  reask?: OpenQuestionsReask | null;
  /** "Decide these N" (decision mode), when it is offered: the list's first row. */
  decide?: OpenQuestionsDecide | null;
  /** The button itself, for whoever puts focus back on it (the Re-ask route choice's Cancel). */
  triggerRef?: Ref<HTMLButtonElement>;
  /** A phone: the button reads "5 open" at most, the list is a bottom sheet with 44 px targets. */
  phone: boolean;
  /** Where each card sits now, measured when the list opens. */
  measure: () => ReadonlyMap<string, OpenQuestionPlace>;
  /** A row was chosen: scroll to its card (opening a folded message) and ring it. */
  onPick: (question: OpenQuestion) => void;
  /**
   * Skipping from the list (approval "oq-skip-select", variant A): "Skip…"
   * enters a select mode, and its button sets these questions skipped (true)
   * or not (false), each exactly as its card's own Skip / Unskip does (a pick
   * saved as skipped, which goes with the next Send). Absent: no "Skip…".
   */
  onSetSkipped?: (questions: readonly OpenQuestion[], skipped: boolean) => void;
  /**
   * The form the whole foot row chose so that the buttons and the draft
   * status share one line (footFit.ts `fitWholeFootRow`): drawn as it is, no
   * fitting of its own. Null or absent: the button fits itself among the buttons.
   */
  rowForm?: OpenQuestionsLabelForm | null;
}

/**
 * The "N open questions" button in the thread's foot and the short list it
 * opens (approval "inbox-thread-open-questions", option A): one row per open
 * question with its prompt, its state (Stopped, Holds up, or the draft pick)
 * and where its card is. Choosing a row takes the person to the real card;
 * nothing is answered here. Base UI's Menu carries the keys (arrows,
 * Home/End, type-ahead; Escape and Tab close, focus back to the button) and
 * `aria-haspopup` / `aria-expanded` on the button. On a phone the list is a
 * sheet from the bottom edge, as the project menu's. No keyboard shortcut.
 *
 * The label takes the longest form that keeps the foot's buttons on one line
 * ("5 open questions", "5 open", "5"; footFit.ts), trying each on the row's
 * usual spacing and then a tighter one; a phone never takes the long form.
 * The name always holds the whole count.
 */
export function OpenQuestionsButton({ questions, actions = 0, reask = null, decide = null, triggerRef, phone, measure, onPick, onSetSkipped, rowForm = null }: OpenQuestionsButtonProps) {
  const [open, setOpen] = useState(false);
  /** Select mode (approval "oq-skip-select"): rows are checkboxes; ticks save nothing until the bar's button. */
  const [selecting, setSelecting] = useState(false);
  const [tickedIds, setTickedIds] = useState<ReadonlySet<string>>(new Set());
  /**
   * What "Skip all N" covers, taken when select mode starts: a question that lands while the person
   * is choosing is never skipped by it (it is the snapshot met with the questions open now).
   */
  const [skipAllIds, setSkipAllIds] = useState<ReadonlySet<string>>(new Set());
  /** After entering or leaving select mode, where focus goes: the first row, or "Skip…". */
  const focusAfter = useRef<'row' | 'skip' | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [places, setPlaces] = useState<ReadonlyMap<string, OpenQuestionPlace>>(new Map());
  const trigger = useRef<HTMLButtonElement>(null);
  /** A row was chosen: focus goes to its card, not back to the button. */
  const picked = useRef(false);
  // The list is drawn inside the window's root, so the window's styles (and theme) reach it.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  // Only action items wait (Re-ask is offered): the button counts them.
  const noun: OpenQuestionsNoun = questions.length === 0 && actions > 0 ? 'action item' : 'question';
  const n = noun === 'question' ? questions.length : actions;
  const reaskTipId = useId();
  const skipTipId = useId();
  const max: OpenQuestionsLabelForm = phone ? 'short' : 'full';
  const [fitted, setFitted] = useState<FootFit>({ form: max, tight: false });
  const words = useRef<HTMLSpanElement>(null);
  /** What the last fit was made for: the row's width, the other buttons' words, the count. */
  const fittedFor = useRef('');
  /**
   * The longest form that keeps the row's buttons on one line, tried on the page itself (footFit.ts). Only
   * when the row's width, the buttons beside it or the count changed since the last fit.
   */
  const fit = useCallback(
    (force = false) => {
      const button = trigger.current;
      const buttons = button?.parentElement;
      const row = buttons?.parentElement;
      if (!button || !words.current || !buttons || !row) return;
      if (rowForm) {
        // The row chose: draw it (the row's own fit already left the page this way).
        fittedFor.current = `row:${rowForm}|${n}`;
        const next = { form: rowForm, tight: false };
        drawOpenQuestionsForm(button, next);
        setFitted((current) => (current.form === next.form && current.tight === next.tight ? current : next));
        return;
      }
      const others = laidOutChildren(buttons)
        .filter((el) => el !== button)
        .map((el) => el.textContent ?? '')
        .join('|');
      const key = `${row.getBoundingClientRect().width}|${n}|${max}|${others}`;
      if (!force && key === fittedFor.current) return;
      fittedFor.current = key;
      const apply = (next: FootFit) => drawOpenQuestionsForm(button, next);
      const next = fitFootRow(buttons, footFitCandidates(max), apply) ?? { form: max, tight: false };
      // The page now shows `next` (or the longest form, where there is no layout): React draws the same.
      apply(next);
      setFitted((current) => (current.form === next.form && current.tight === next.tight ? current : next));
    },
    [n, max, noun, rowForm],
  );
  // Every render: a button beside it may have come or gone (Send, 👍) with no resize.
  useLayoutEffect(() => fit());
  useEffect(() => {
    const row = trigger.current?.parentElement?.parentElement;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(row);
    // Words measured in a fallback font fit differently once the real one loads.
    void document.fonts?.ready.then(() => fit(true));
    return () => observer.disconnect();
  }, [fit]);
  const form = rowForm ?? fitted.form;
  const tight = rowForm ? false : fitted.tight;
  // The button can go while its list is open (the last open questions were answered elsewhere): focus would
  // fall to the page with the list, so it goes to the foot's Reply (or Edit draft) instead.
  const openRef = useRef(false);
  openRef.current = open;
  useEffect(() => {
    const row = trigger.current?.parentElement ?? null;
    return () => {
      if (!openRef.current || !row) return;
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        if (!row.isConnected) return;
        row.querySelector<HTMLElement>('[data-reply-button]')?.focus();
      }, 0);
    };
  }, []);
  const label = openQuestionsLabel(n, noun);
  const heading = openQuestionsHeading(n, noun);

  // Skipping from the list (approval "oq-skip-select", variant A).
  const canSkip = !!onSetSkipped && questions.some(openQuestionSkippable);
  // A tick on a question that left the list (answered elsewhere) no longer counts.
  const ticks = new Set(questions.filter((q) => tickedIds.has(q.id)).map((q) => q.id));
  const { skip: toSkip, unskip: toUnskip } = skipSelection(questions, ticks);
  const allToSkip = skipAllCandidates(questions).filter((q) => skipAllIds.has(q.id));
  const applyReady = toSkip.length + toUnskip.length > 0;
  const applyLabel =
    toSkip.length > 0 && toUnskip.length > 0
      ? `Skip ${formatCount(toSkip.length)}, unskip ${formatCount(toUnskip.length)}`
      : toUnskip.length > 0
        ? `Unskip ${formatCount(toUnskip.length)}`
        : toSkip.length > 0
          ? `Skip ${formatCount(toSkip.length)}`
          : 'Skip';
  const enterSelect = () => {
    setTickedIds(new Set());
    setSkipAllIds(new Set(skipAllCandidates(questions).map((q) => q.id)));
    focusAfter.current = 'row';
    setSelecting(true);
  };
  /** Cancel, Escape, or the work done: ticks are dropped, focus back on "Skip…". */
  const leaveSelect = () => {
    setTickedIds(new Set());
    setSkipAllIds(new Set());
    focusAfter.current = 'skip';
    setSelecting(false);
  };
  /** The list closes and starts at rest next time: no select mode, no ticks, no focus to move. */
  const resetSelect = () => {
    setSelecting(false);
    setTickedIds(new Set());
    setSkipAllIds(new Set());
    focusAfter.current = null;
  };
  /** Every close the list makes itself (the phone's Close, a row, Re-ask) goes through here. */
  const close = () => {
    resetSelect();
    setOpen(false);
  };
  const tick = (id: string, on: boolean) =>
    setTickedIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const apply = () => {
    if (!onSetSkipped || !applyReady) return;
    if (toSkip.length > 0) onSetSkipped(toSkip, true);
    if (toUnskip.length > 0) onSetSkipped(toUnskip, false);
    leaveSelect();
  };
  const skipAll = () => {
    if (!onSetSkipped || allToSkip.length === 0) return;
    onSetSkipped(allToSkip, true);
    leaveSelect();
  };
  const skipAllButton =
    allToSkip.length > 0 ? (
      <Menu.Item
        className={phone ? 'ib-oq-skipmode' : 'ib-oq-bbtn ib-oq-ghost'}
        data-open-questions-skip-all=""
        label={`Skip all ${formatCount(allToSkip.length)}`}
        closeOnClick={false}
        onClick={() => skipAll()}
      >
        Skip all {formatCount(allToSkip.length)}
      </Menu.Item>
    ) : null;
  // Focus follows the mode: the first row on the way in, "Skip…" on the way out (the items remount).
  useLayoutEffect(() => {
    const where = focusAfter.current;
    if (!where || !open) return;
    focusAfter.current = null;
    const popup = popupRef.current;
    const target =
      where === 'row'
        ? popup?.querySelector<HTMLElement>('[data-open-question]:not([data-disabled])')
        : popup?.querySelector<HTMLElement>('[data-open-questions-skip-mode]');
    target?.focus();
  }, [selecting, open]);

  return (
    <Menu.Root
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        // Escape leaves select mode (dropping the ticks) before it closes the list.
        if (!next && selecting && details.reason === 'escape-key') {
          details.cancel();
          details.event.preventDefault();
          leaveSelect();
          return;
        }
        // Whatever closed it, the list opens at rest again (never in select mode with old ticks).
        resetSelect();
        if (next) {
          picked.current = false;
          setPlaces(measure());
        }
        setOpen(next);
      }}
    >
      <Menu.Trigger
        ref={(el: HTMLButtonElement | null) => {
          trigger.current = el;
          if (typeof triggerRef === 'function') triggerRef(el);
          else if (triggerRef) (triggerRef as { current: HTMLButtonElement | null }).current = el;
        }}
        className="ib-btn ib-oq-btn"
        data-open-questions=""
        // A shorter form ("5 open", "5"): the name keeps the whole count.
        aria-label={form === 'full' ? undefined : label}
        data-label-form={form}
        data-fit-tight={tight ? '' : undefined}
        // What footFit.ts draws each form from.
        data-oq-n={n}
        data-oq-noun={noun}
        data-oq-label={label}
      >
        <Icon name="question" size={15} />
        <span ref={words} data-oq-words="">
          {openQuestionsFormText(n, form, noun)}
        </span>
        <span className="ib-oq-chev" aria-hidden="true">
          <Icon name="chevU" size={13} />
        </span>
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-oq-scrim" data-open-questions-scrim="" />}
        {/* The count of ticks, said politely as it changes (outside the menu, whose children are its items). */}
        <span className="ib-sr" role="status" aria-live="polite" data-open-questions-select-live="">
          {selecting && ticks.size > 0 ? `${formatCount(ticks.size)} selected` : ''}
        </span>
        <Menu.Positioner
          className="ib-oq-pos"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          data-phone={phone ? '' : undefined}
        >
          <Menu.Popup
            ref={popupRef}
            className="ib-oq"
            aria-label={selecting ? 'Select questions to skip' : heading}
            data-open-questions-list=""
            finalFocus={() => (picked.current ? false : true)}
          >
            {/* No drawn heading or foot line (owner, 2026-10-23): the popup's name (aria-label) carries the count. */}
            {phone && (
              <div className="ib-oq-head">
                <button type="button" className="ib-oq-x" aria-label="Close" data-open-questions-close="" onClick={() => close()}>
                  <Icon name="x" size={16} />
                </button>
              </div>
            )}
            {selecting && (
              <div className="ib-oq-selhead" role="none" data-open-questions-select-head="">
                {/* Heard through the live region below, not here: the menu's name says the mode. */}
                <span aria-hidden="true">{ticks.size > 0 ? `${formatCount(ticks.size)} selected` : 'Select questions to skip'}</span>
                {phone && skipAllButton}
              </div>
            )}
            {/* Decision mode's way in: the same dialog, scoped to this thread. Not while choosing what to skip. */}
            {decide && !selecting && (
              <>
                <Menu.Item
                  className="ib-oq-decide"
                  data-thread-decide=""
                  label={decideThreadLabel(decide.count, questions.length)}
                  aria-haspopup="dialog"
                  onClick={() => {
                    // Focus goes into the dialog, not back to the button (the dialog puts it back when it closes).
                    picked.current = true;
                    close();
                    decide.onDecide();
                  }}
                >
                  <Icon name="todo" size={15} />
                  <span>{decideThreadLabel(decide.count, questions.length)}</span>
                  <Icon name="chevR" size={15} />
                </Menu.Item>
                <Menu.Separator className="ib-oq-sep" />
              </>
            )}
            <div className="ib-oq-list">
              {questions.map((q, i) => {
                const state = openQuestionState(q);
                const place = openQuestionPlaceWords(places.get(q.id) ?? 'below');
                const when = whenTime(q.at);
                const skipped = openQuestionSkipped(q);
                const stateWords = skipped
                  ? 'Skipped'
                  : state?.kind === 'draft'
                    ? `Draft, ${q.question.answer ? pickWords(q.question.answer) : ''}`
                    : state?.kind === 'stopped'
                      ? 'Stopped'
                      : state?.kind === 'holds'
                        ? `Holds up ${state.count}`
                        : '';
                const ariaLabel = [q.prompt, stateWords, `${when}, ${place}`].filter(Boolean).join('. ');
                const body = (
                  <>
                    <span className="ib-oq-main">
                      <span className="ib-oq-p" dir="auto">
                        {q.prompt}
                      </span>
                      <span className="ib-oq-meta">
                        {/* Skipped: the row goes quiet ("Skipped · time · place"), never "Draft · Skipped". */}
                        {skipped && <span className="ib-oq-skipped">Skipped</span>}
                        {!skipped && state?.kind === 'draft' && (
                          <span className="ib-draft-l ib-oq-draft">
                            <b>Draft</b> <span aria-hidden="true">·</span> <span dir="auto">{q.question.answer ? pickWords(q.question.answer) : ''}</span>
                          </span>
                        )}
                        {!skipped && state?.kind === 'stopped' && <span className="ib-badge ib-b-stop ib-oq-badge">Stopped</span>}
                        {!skipped && state?.kind === 'holds' && <span className="ib-badge ib-b-hold ib-oq-badge">Holds up {state.count}</span>}
                        <span className="ib-oq-when">
                          {when} · {place}
                        </span>
                      </span>
                    </span>
                    <span className="ib-oq-go" aria-hidden="true">
                      <Icon name="chevR" size={15} />
                    </span>
                  </>
                );
                if (selecting) {
                  // Select mode (approval "oq-skip-select", variant A): the number turns into a round check.
                  // A tick saves nothing; the bar's button does.
                  return (
                    <Menu.CheckboxItem
                      key={q.id}
                      className="ib-oq-row"
                      label={q.prompt}
                      data-open-question={q.id}
                      data-select=""
                      data-skipped={skipped ? '' : undefined}
                      aria-label={ariaLabel}
                      closeOnClick={false}
                      disabled={!openQuestionSkippable(q)}
                      checked={ticks.has(q.id)}
                      onCheckedChange={(on) => tick(q.id, on)}
                    >
                      <span className="ib-oq-ck" aria-hidden="true">
                        <Icon name="check" size={phone ? 13 : 11} />
                      </span>
                      {body}
                    </Menu.CheckboxItem>
                  );
                }
                return (
                  <Menu.Item
                    key={q.id}
                    className="ib-oq-row"
                    label={q.prompt}
                    data-open-question={q.id}
                    data-skipped={skipped ? '' : undefined}
                    aria-label={ariaLabel}
                    onClick={() => {
                      picked.current = true;
                      close();
                      onPick(q);
                    }}
                  >
                    <span className="ib-oq-n" aria-hidden="true">
                      {skipped ? <Icon name="forward" size={phone ? 14 : 12} /> : i + 1}
                    </span>
                    {body}
                  </Menu.Item>
                );
              })}
            </div>
            {selecting ? (
              <>
                {questions.length > 0 && <Menu.Separator className="ib-oq-sep" />}
                <div className="ib-oq-selbar" role="none" data-open-questions-select-bar="">
                  <Menu.Item className="ib-oq-bbtn ib-oq-ghost" data-open-questions-cancel="" label="Cancel" closeOnClick={false} onClick={() => leaveSelect()}>
                    Cancel
                  </Menu.Item>
                  <span className="ib-oq-sp" />
                  {!phone && skipAllButton}
                  <Menu.Item
                    className="ib-oq-bbtn ib-oq-pri"
                    data-open-questions-apply=""
                    label={applyLabel}
                    closeOnClick={false}
                    disabled={!applyReady}
                    onClick={() => apply()}
                  >
                    {applyLabel}
                  </Menu.Item>
                </div>
              </>
            ) : (
              (reask || canSkip) && (
                <>
                  {questions.length > 0 && <Menu.Separator className="ib-oq-sep" />}
                  {/* The list's last row (approval "oq-skip-select"): Re-ask on the left, a quiet "Skip…" on the right. */}
                  <div className="ib-oq-last" role="none">
                    {reask && (
                      <Tip content={reask.tooltip}>
                        <Menu.Item
                          className="ib-oq-reask"
                          data-reask=""
                          label={reask.label}
                          disabled={reask.busy}
                          aria-describedby={reaskTipId}
                          onClick={() => {
                            // Focus goes back to the button (or to the route choice, which takes it).
                            close();
                            reask.onReask();
                          }}
                        >
                          <Icon name="refresh" size={15} />
                          <span>{reask.label}</span>
                        </Menu.Item>
                      </Tip>
                    )}
                    <span className="ib-oq-sp" />
                    {canSkip && (
                      <Tip content={SKIP_MODE_TIP}>
                        <Menu.Item
                          className="ib-oq-skipmode"
                          data-open-questions-skip-mode=""
                          label="Skip…"
                          closeOnClick={false}
                          aria-describedby={skipTipId}
                          onClick={() => enterSelect()}
                        >
                          Skip…
                        </Menu.Item>
                      </Tip>
                    )}
                  </div>
                  {/* The tooltips tag nothing for a screen reader: the same words as the items' descriptions. */}
                  {reask && (
                    <span id={reaskTipId} hidden>
                      {reask.tooltip}
                    </span>
                  )}
                  {canSkip && (
                    <span id={skipTipId} hidden>
                      {SKIP_MODE_TIP}
                    </span>
                  )}
                </>
              )
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
