import { Menu } from '@base-ui/react/menu';
import { Icon } from '../icons';
import { useBeside } from './beside';

/** The rows' menu's "Open to the side", in its own group at the top, only where it is offered (beside.ts). */
export function OpenBesideItem({ threadId }: { threadId: string }) {
  const beside = useBeside();
  if (!beside?.offers(threadId)) return null;
  return (
    <>
      <Menu.Item className="ib-pmi" label="Open to the side" data-row-action="open-beside" onClick={() => beside.open(threadId)}>
        <Icon name="sideBySide" size={15} />
        Open to the side
      </Menu.Item>
      <Menu.Separator className="ib-pm-sep" />
    </>
  );
}
