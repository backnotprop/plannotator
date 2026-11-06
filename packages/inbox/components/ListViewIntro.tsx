import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import type { ListLook } from '../listLook';
import type { ListView } from '../listView';
import { lightScope, PreviewList, type ListIntroGroup } from './ListLookIntro';
import { Modal } from './Updates';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';

/** The dialog's words, as the owner approved them (2026-11-05). */
export const LIST_VIEW_INTRO_WORDS = {
  title: 'Which view do you prefer?',
  note: 'You can change this any time in the ⋮ menu.',
  smart: 'Smart groups',
  recommended: 'Recommended',
  inUse: 'In use',
  smartLine: 'Puts what needs you on top and sorts the rest for you.',
  simple: 'Simple list',
  simpleLine: 'Every thread, newest first, like email.',
} as const;

export interface ListViewIntroProps {
  /** The person's list as the groups draw it (Quiet folded: its band only), for the Smart groups picture. */
  groups: readonly ListIntroGroup[];
  /** The same threads as the Simple list draws them, newest first, for its picture. */
  flat: readonly { row: InboxListRow; drawn: InboxListGroupId }[];
  look: ListLook;
  projectNames?: ReadonlyMap<string, string>;
  awayMachines?: ReadonlySet<string>;
  phone: boolean;
  /** The view the list draws now: its choice is marked "In use". */
  current: ListView;
  /** Smart groups, or Escape: the groups stay. */
  onSmart: () => void;
  /** Simple list: the list switches at once, remembered as the ⋮ menu's choice. */
  onSimple: () => void;
}

/** A small picture of the person's own list, drawn by the real rows, light for everyone (as the list options dialog's). */
function Thumb({ groups, flat, look, projectNames, awayMachines }: Pick<ListViewIntroProps, 'look' | 'projectNames' | 'awayMachines'> & { groups: readonly ListIntroGroup[]; flat?: ListViewIntroProps['flat'] }) {
  const { lightTheme } = useTheme();
  return (
    <span className="ib-lvc-thumb" aria-hidden="true">
      <span className={`ib-lvc-frame ${lightScope(lightTheme)}`} inert>
        <PreviewList groups={groups} flat={flat} look={look} projectNames={projectNames} awayMachines={awayMachines} phone={false} head={false} />
      </span>
    </span>
  );
}

/**
 * The List view's one-time choice (the owner, 2026-11-05: "smart groups versus simple list … we recommend the smart
 * groups, but you could also treat it like a simple email list"): two columns side by side, each a small picture of
 * the person's own list, its name, one line and a button. Smart groups is marked "Recommended" and its button is the
 * primary one (the owner's pick); the view the list draws now is marked "In use". One click picks either and closes
 * it; Escape and a click outside keep Smart groups. Focus starts on the question (Tab reaches Smart groups first).
 * No keyboard shortcut.
 */
export function ListViewIntro({ groups, flat, look, projectNames, awayMachines, phone, current, onSmart, onSimple }: ListViewIntroProps) {
  const words = LIST_VIEW_INTRO_WORDS;
  const thumbs = { look, projectNames, awayMachines };
  const choices = [
    { key: 'smart', name: words.smart, line: words.smartLine, tag: words.recommended, primary: true, inUse: current === 'grouped', pick: onSmart, thumb: <Thumb {...thumbs} groups={groups} /> },
    { key: 'simple', name: words.simple, line: words.simpleLine, tag: null, primary: false, inUse: current === 'list', pick: onSimple, thumb: <Thumb {...thumbs} groups={[]} flat={flat} /> },
  ] as const;
  return (
    <Modal
      labelledBy="ib-lvc-title"
      describedBy="ib-lvc-note"
      testId="list-view-intro"
      onClose={onSmart}
      ownKeys
      initialFocus="#ib-lvc-title"
      className={`ib-lvc${phone ? ' ib-lvc-phone' : ''}`}
    >
      <div className="ib-lvc-head">
        {/* Focus starts on the question, not on a choice: neither looks picked before the person picks. */}
        <h2 id="ib-lvc-title" tabIndex={-1}>
          {words.title}
        </h2>
        <p id="ib-lvc-note">{words.note}</p>
      </div>
      <div className="ib-lvc-choices" role="group" aria-labelledby="ib-lvc-title">
        {choices.map((choice) => (
          <div key={choice.key} className="ib-lvc-col">
            {choice.thumb}
            <span className="ib-lvc-name" id={`ib-lvc-${choice.key}`}>
              {choice.name}
              {choice.tag && <span className="ib-lvc-tag">{choice.tag}</span>}
              {choice.inUse && (
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
              className={`ib-btn ib-lvc-pick${choice.primary ? ' ib-pri' : ''}`}
              onClick={choice.pick}
              aria-describedby={`ib-lvc-${choice.key} ib-lvc-${choice.key}-line`}
              data-list-view-choice={choice.key}
            >
              Use {choice.name}
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
