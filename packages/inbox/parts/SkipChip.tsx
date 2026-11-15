import { Icon } from '../icons';
import { formatCount } from '../format';

export function SkipChip({ count, keepOpen, onToggle }: { count: number; keepOpen: boolean; onToggle: () => void }) {
  if (count === 0) return null;
  const them = count === 1 ? 'it' : 'them';
  return (
    <span className="ib-skipchip" data-skip-chip={keepOpen ? 'keep' : 'skip'}>
      <span className="ib-skip-s">
        {!keepOpen && <Icon name="forward" size={14} />}
        <span>
          {formatCount(count)}
          {keepOpen ? ` question${count === 1 ? ' stays' : 's stay'} open` : ` question${count === 1 ? '' : 's'} will be skipped`}
        </span>
      </span>
      <button type="button" onClick={onToggle} data-skip-toggle="">
        {keepOpen ? `Skip ${them}` : 'Keep open'}
      </button>
    </span>
  );
}
