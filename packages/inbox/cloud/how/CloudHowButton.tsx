import { useState } from 'react';
import { Icon } from '../../icons';
import { CloudHowDialog } from './CloudHowDialog';

export function CloudHowButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="ib-btn ib-ghost ib-sm ib-chow-open" aria-haspopup="dialog" onClick={() => setOpen(true)} data-cloud-how="">
        <Icon name="question" size={14} />
        How does this work?
      </button>
      {open && <CloudHowDialog onClose={() => setOpen(false)} />}
    </>
  );
}
