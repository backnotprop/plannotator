import { Tip } from '../components/Tip';
import { Icon } from '../icons';

export function BoardChip(props: { on: boolean; onToggle: () => void }) {
  return (
    <Tip content={props.on ? 'On your Board when sent' : 'Track on your Board'}>
      <button type="button" className="ib-cp-board" aria-pressed={props.on} aria-label="Track on Board" data-compose-board="" onClick={props.onToggle}>
        <span className="ib-cp-board-box" aria-hidden="true">
          {props.on && <Icon name="check" size={11} />}
        </span>
        Board
      </button>
    </Tip>
  );
}
