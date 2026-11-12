import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import type { ListLook } from '../listLook';
import type { ListView } from '../listView';
import { lightScope, PreviewList, type ListIntroGroup } from './ListLookIntro';
import { Modal } from './Updates';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';

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
  groups: readonly ListIntroGroup[];
  flat: readonly { row: InboxListRow; drawn: InboxListGroupId }[];
  look: ListLook;
  projectNames?: ReadonlyMap<string, string>;
  awayMachines?: ReadonlySet<string>;
  phone: boolean;
  current: ListView;
  onSmart: () => void;
  onDismiss?: () => void;
  onSimple: () => void;
}

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

export function ListViewIntro({ groups, flat, look, projectNames, awayMachines, phone, current, onSmart, onDismiss, onSimple }: ListViewIntroProps) {
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
      onClose={onDismiss ?? onSmart}
      ownKeys
      initialFocus="#ib-lvc-title"
      className={`ib-lvc${phone ? ' ib-lvc-phone' : ''}`}
    >
      <div className="ib-lvc-head">
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
