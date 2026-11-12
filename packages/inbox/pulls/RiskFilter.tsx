import { useEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Icon } from '../icons';
import { riskFilterWords, type RiskFilterValue } from './risk';

const OPTIONS: RiskFilterValue[] = ['all', 'high', 'medium'];

export function RiskFilter({ value, rulesSet, phone, onChange, onRules }: { value: RiskFilterValue; rulesSet: boolean; phone: boolean; onChange: (value: RiskFilterValue) => void; onRules: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  return (
    <span className="ib-bpf ib-pr-riskf" data-set={value === 'all' ? undefined : ''} data-pulls-risk-filter={value}>
      <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
        <Menu.Trigger ref={trigger} className="ib-bpf-btn" data-pulls-risk-chip="">
          <span className="ib-bpf-l">
            <span className="ib-sr">Risk: </span>
            {value === 'all' ? 'Risk' : riskFilterWords[value]}
          </span>
          <Icon name="chevD" size={13} />
        </Menu.Trigger>
        <Menu.Portal container={portal ?? undefined}>
          {phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={phone ? '' : undefined}>
            <Menu.Popup className="ib-pm ib-bpf-menu" aria-label="Risk" finalFocus={(closeType) => closeType === 'keyboard'} data-pulls-risk-menu="">
              {rulesSet && (
                <>
                  <div className="ib-pm-title" aria-hidden="true">
                    Risk
                  </div>
                  <Menu.RadioGroup value={value} onValueChange={(next: RiskFilterValue) => onChange(next)}>
                    {OPTIONS.map((option) => (
                      <Menu.RadioItem key={option} value={option} closeOnClick className="ib-pmi" label={riskFilterWords[option]} data-pulls-risk-option={option}>
                        <span className="ib-pmi-l">{riskFilterWords[option]}</span>
                        {value === option && <Icon name="check" size={15} className="ib-pmi-check" />}
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                  <Menu.Separator className="ib-pm-sep" />
                </>
              )}
              <Menu.Item className="ib-pmi" label="No slop zone rules" onClick={onRules} data-pulls-risk-rules="">
                <span className="ib-pmi-l">No slop zone rules…</span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </span>
  );
}
