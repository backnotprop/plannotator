import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { listLookClasses, type ListLook } from '../listLook';
import type { ListView } from '../listView';
import type { MachinesModel } from '../machines';
import { AgentsList } from '../agentsView/AgentsList';
import { LineRow } from '../agentsView/LineRow';
import { lightScope, PreviewList, type ListIntroGroup } from './ListLookIntro';
import { Modal } from './Updates';
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
  /** The person's list as the groups draw it (Quiet folded: its band only), for the Smart groups picture. */
  groups: readonly ListIntroGroup[];
  /** The same threads as the Simple list draws them, newest first, for its picture. */
  flat: readonly { row: InboxListRow; drawn: InboxListGroupId }[];
  /**
   * The person's list as sections, for the Agents picture: the real Agents view draws them under the person's own
   * agents (agentsList.ts, which every list read fills). What the Agents picture shows is decided here.
   */
  sections: readonly InboxListSection[];
  machines?: MachinesModel;
  look: ListLook;
  projectNames?: ReadonlyMap<string, string>;
  awayMachines?: ReadonlySet<string>;
  phone: boolean;
  /** The view the list draws now: its choice is marked "In use" and its button is the filled one. */
  current: ListView;
  /** A pick: the list switches at once, remembered as the ⋮ menu's choice (the current view's pick keeps it). */
  onPick: (view: ListView) => void;
  /** Escape or a click outside: the current view stays (the line counts it as Not now). */
  onDismiss: () => void;
}

const noop = () => {};

/** The Agents view as the list draws it, in a picture: the person's own agents with the real one-line rows. */
function AgentsPicture({ sections, machines, look }: Pick<ListViewIntroProps, 'sections' | 'machines' | 'look'>) {
  return (
    <section className={`ib-listcol ib-narrow ib-lo-list${listLookClasses(look)}`} aria-hidden="true" data-list-intro-preview="">
      <div className="ib-lbody">
        <AgentsList
          sections={sections}
          machines={machines}
          selectedThreadId={null}
          phone={false}
          remember={false}
          picture
          renderRow={(row, drawn) => (
            <LineRow key={row.thread_id} row={row} drawn={drawn} phone={false} away={false} selected={false} lit={false} menu={false} pinned={false} pill={look.highlight} relative={false} statusMark={false} picking={false} picked={false} tagName={null} onOpen={noop} />
          )}
        />
      </div>
    </section>
  );
}

/** A small picture of the person's own list in one view, drawn by the real rows, light for everyone (as the list options dialog's). */
function Thumb({ choice, props }: { choice: ListViewChoiceKey; props: ListViewIntroProps }) {
  const { lightTheme } = useTheme();
  const { groups, flat, look, projectNames, awayMachines } = props;
  return (
    <span className="ib-lvc-thumb" aria-hidden="true" data-view-picture={choice}>
      <span className={`ib-lvc-frame ${lightScope(lightTheme)}`} inert>
        {choice === 'agents' ? (
          <AgentsPicture sections={props.sections} machines={props.machines} look={look} />
        ) : (
          <PreviewList groups={choice === 'smart' ? groups : []} flat={choice === 'simple' ? flat : undefined} look={look} projectNames={projectNames} awayMachines={awayMachines} phone={false} head={false} />
        )}
      </span>
    </span>
  );
}

/**
 * "Which view do you prefer?" (the owner, layout C "Agents first and larger", 2026-11-20; it replaced the two-choice
 * dialog of 2026-11-05): Agents first, its picture the larger, tagged "New"; then Smart groups ("Recommended") and
 * Simple list. Each a small picture of the person's own list in that view, its name, one line and a button. It follows
 * the person's view (the owner: "if somebody's already using the simple list, it should stick to that"): the view in
 * use is tagged "In use" and its button is the filled one. One click picks and closes; Escape and a click outside keep
 * the current view. Focus starts on the question. No keyboard shortcut. A phone's bottom sheet puts Agents across the
 * top and the two others side by side under it.
 */
export function ListViewIntro(props: ListViewIntroProps) {
  const { phone, current, onPick, onDismiss } = props;
  const words = LIST_VIEW_INTRO_WORDS;
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
              <Thumb choice={choice.key} props={props} />
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
                Use {choice.name}
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
