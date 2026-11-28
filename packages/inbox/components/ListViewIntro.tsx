import { useMemo, useRef } from 'react';
import { LIST_LOOK_DEFAULT, listLookClasses } from '../listLook';
import type { ListView } from '../listView';
import { RowMarksScope } from '../letterMarks';
import { PictureWorldContext } from '../pictureWorld';
import { AgentsList } from '../agentsView/AgentsList';
import { LineRow } from '../agentsView/LineRow';
import { lightScope, PreviewList } from './ListLookIntro';
import { Modal } from './Updates';
import { viewChoiceDemo, type ViewChoiceDemo } from './viewChoiceDemo';
import { useFoldLoop } from './viewChoiceFolds';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';

/** The dialog's words, as the owner approved them (two choices 2026-11-05; Agents added, layout C, 2026-11-20). */
export const LIST_VIEW_INTRO_WORDS = {
  title: 'Which view do you prefer?',
  note: 'You can change this any time in the ⋮ menu.',
  recommended: 'Recommended',
  inUse: 'In use',
  fresh: 'New',
  agents: 'Agents',
  agentsLine: 'Your agents, each with its threads.',
  smart: 'Smart groups',
  smartLine: 'Puts what needs you on top and sorts the rest for you.',
  simple: 'Simple list',
  simpleLine: 'Every thread, newest first, like email.',
  /** The buttons: "Use <view>", and "Keep <view>" for the view in use (the owner, 2026-11-20: keep versus use). */
  use: 'Use',
  keep: 'Keep',
} as const;

/**
 * NOT DECIDED YET (a switch): whether someone on Simple list still sees "Recommended" on Smart groups. False: no tag
 * for them (their own view is the one marked, "In use"); true: Smart groups is tagged for everyone.
 */
export const RECOMMEND_SMART_ON_SIMPLE = false;

/** A choice's key, as its button names it (`data-list-view-choice`). */
export type ListViewChoiceKey = 'agents' | 'smart' | 'simple';

const VIEW_OF: Record<ListViewChoiceKey, ListView> = { agents: 'agents', smart: 'grouped', simple: 'list' };

export interface ListViewIntroProps {
  phone: boolean;
  /** The view the list draws now: its choice is marked "In use" and its button, "Keep …", is the filled one. */
  current: ListView;
  /** A pick: the list switches at once, remembered as the ⋮ menu's choice (Keep picks the current view: it stays). */
  onPick: (view: ListView) => void;
  /** Escape or a click outside: the current view stays (the line counts it as Not now). */
  onDismiss: () => void;
}

const noop = () => {};
const LOOK = LIST_LOOK_DEFAULT;

/**
 * The Agents view in a picture: the real view, with the demo's agents (its world) and the real one-line rows. Two of
 * its agents fold and open by themselves in a calm loop (viewChoiceFolds.ts), to show that agents fold.
 */
function AgentsPicture({ demo }: { demo: ViewChoiceDemo }) {
  const ref = useRef<HTMLElement>(null);
  const folded = useFoldLoop(ref, demo.folding);
  return (
    <section ref={ref} className={`ib-listcol ib-narrow ib-lo-list${listLookClasses(LOOK)}`} aria-hidden="true" data-list-intro-preview="">
      <div className="ib-lbody">
        <AgentsList
          folded={folded}
          sections={demo.sections}
          selectedThreadId={null}
          phone={false}
          remember={false}
          renderRow={(row, drawn) => (
            <LineRow key={row.thread_id} row={row} drawn={drawn} phone={false} away={false} selected={false} lit={false} menu={false} pinned={false} pill={LOOK.highlight} relative={false} statusMark={false} picking={false} picked={false} tagName={null} onOpen={noop} />
          )}
        />
      </div>
    </section>
  );
}

/**
 * A small picture of one view, drawn by the real rows with the demo's agents and threads (viewChoiceDemo.ts), the
 * rows' default look and light for everyone (as the list options dialog's): the same picture for every person.
 */
function Thumb({ choice, demo }: { choice: ListViewChoiceKey; demo: ViewChoiceDemo }) {
  const { lightTheme } = useTheme();
  return (
    <span className="ib-lvc-thumb" aria-hidden="true" data-view-picture={choice}>
      <span className={`ib-lvc-frame ${lightScope(lightTheme)}`} inert>
        {/* The demo's agents and faces (pictureWorld.ts) and the rows' default marks, never the person's. */}
        <PictureWorldContext.Provider value={demo.world}>
          <RowMarksScope look={LOOK}>
            {choice === 'agents' ? <AgentsPicture demo={demo} /> : <PreviewList groups={choice === 'smart' ? demo.groups : []} flat={choice === 'simple' ? demo.flat : undefined} look={LOOK} phone={false} head={false} />}
          </RowMarksScope>
        </PictureWorldContext.Provider>
      </span>
    </span>
  );
}

/**
 * "Which view do you prefer?" (the owner, layout C "Agents first and larger", 2026-11-20; it replaced the two-choice
 * dialog of 2026-11-05): Agents first, its picture the larger, tagged "New"; then Smart groups ("Recommended") and
 * Simple list. Each a small picture of that view, its name, one line and a button. The pictures are a fixed demo, the
 * picture the owner designed, shown to everyone (2026-11-20: "just show the generic images"), never the person's own
 * list. It follows the person's view (the owner: "if somebody's already using the simple list, it should stick to
 * that"): the view in use is tagged "In use" and its button, the filled one, reads "Keep …"; the others "Use …". One
 * click picks and closes (Keep keeps the view); Escape and a click outside keep the current view. Focus starts on the
 * question. No keyboard shortcut. A phone's bottom sheet puts Agents across the top and the two others side by side
 * under it.
 */
export function ListViewIntro({ phone, current, onPick, onDismiss }: ListViewIntroProps) {
  const words = LIST_VIEW_INTRO_WORDS;
  // The demo as the dialog opens: its times are offsets from now.
  const demo = useMemo(() => viewChoiceDemo(), []);
  const recommend = current !== 'list' || RECOMMEND_SMART_ON_SIMPLE;
  const choices = [
    { key: 'agents', name: words.agents, line: words.agentsLine, tag: words.fresh },
    { key: 'smart', name: words.smart, line: words.smartLine, tag: recommend ? words.recommended : null },
    { key: 'simple', name: words.simple, line: words.simpleLine, tag: null },
  ] as const;
  return (
    <Modal labelledBy="ib-lvc-title" describedBy="ib-lvc-note" testId="list-view-intro" onClose={onDismiss} ownKeys initialFocus="#ib-lvc-title" className={`ib-lvc${phone ? ' ib-lvc-phone' : ''}`}>
      <div className="ib-lvc-head">
        {/* Focus starts on the question, not on a choice: none looks picked before the person picks. */}
        <h2 id="ib-lvc-title" tabIndex={-1}>
          {words.title}
        </h2>
        <p id="ib-lvc-note">{words.note}</p>
      </div>
      <div className="ib-lvc-choices" role="group" aria-labelledby="ib-lvc-title">
        {choices.map((choice) => {
          const inUse = VIEW_OF[choice.key] === current;
          return (
            <div key={choice.key} className={`ib-lvc-col${choice.key === 'agents' ? ' ib-lvc-lead' : ''}`}>
              <Thumb choice={choice.key} demo={demo} />
              <span className="ib-lvc-name" id={`ib-lvc-${choice.key}`}>
                {choice.name}
                {choice.tag && <span className="ib-lvc-tag">{choice.tag}</span>}
                {inUse && (
                  <span className="ib-lvc-tag ib-lvc-inuse" data-list-view-in-use="">
                    {words.inUse}
                  </span>
                )}
              </span>
              <span className="ib-lvc-line" id={`ib-lvc-${choice.key}-line`}>
                {choice.line}
              </span>
              <button
                type="button"
                className={`ib-btn ib-lvc-pick${inUse ? ' ib-pri' : ''}`}
                onClick={() => onPick(VIEW_OF[choice.key])}
                aria-describedby={`ib-lvc-${choice.key} ib-lvc-${choice.key}-line`}
                data-list-view-choice={choice.key}
              >
                {inUse ? words.keep : words.use} {choice.name}
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
