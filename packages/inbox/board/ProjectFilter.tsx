import { useEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { ProjectFolder } from '../api';
import { Icon } from '../icons';
import { Tip, isTextCut } from '../components/Tip';

export interface ProjectFilterProps {
  projects: readonly ProjectFolder[];
  names: ReadonlyMap<string, string>;
  value: string | null;
  phone: boolean;
  onChange: (project: string | null) => void;
}

export function ProjectFilter({ projects, names, value, phone, onChange }: ProjectFilterProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(trigger.current?.closest<HTMLElement>('dialog, .pn-inbox') ?? null), []);
  const name = value ? (names.get(value) ?? null) : null;
  const label = value ? (name ?? 'Project') : 'All projects';
  const clear = value && (
    <button
      type="button"
      className="ib-bpf-x"
      aria-label="Clear the project filter"
      data-board-project-clear=""
      onClick={() => {
        onChange(null);
        requestAnimationFrame(() => (trigger.current ?? document.querySelector<HTMLElement>('.ib-bpage .ib-bhead h1'))?.focus());
      }}
    >
      <Icon name="x" size={13} />
    </button>
  );
  return (
    <span className="ib-bpf" data-set={value ? '' : undefined} data-board-project-filter={value ?? ''}>
      <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
        <Tip content={label} when={(el) => isTextCut(el.querySelector('.ib-bpf-l'))}>
          <Menu.Trigger ref={trigger} className="ib-bpf-btn" data-board-project-chip="">
            <Icon name="folder" size={14} />
            <span className="ib-bpf-l" dir="auto">
              <span className="ib-sr">Project: </span>
              {label}
            </span>
            <Icon name="chevD" size={13} />
          </Menu.Trigger>
        </Tip>
        <Menu.Portal container={portal ?? undefined}>
          {phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} data-phone={phone ? '' : undefined}>
            <Menu.Popup className="ib-pm ib-bpf-menu" aria-label="Project" data-board-project-menu="">
              <div className="ib-pm-title" aria-hidden="true">
                Project
              </div>
              <Menu.RadioGroup value={value ?? ''} onValueChange={(next: string) => next !== (value ?? '') && onChange(next || null)}>
                <Menu.RadioItem value="" closeOnClick className="ib-pmi" label="All projects" data-board-project-option="">
                  <span className="ib-pmi-l">All projects</span>
                  {value === null && <Icon name="check" size={15} className="ib-pmi-check" />}
                </Menu.RadioItem>
                {projects.length > 0 && <Menu.Separator className="ib-pm-sep" />}
                {projects.map((project) => {
                  const shown = names.get(project.id) ?? project.name;
                  return (
                    <Menu.RadioItem key={project.id} value={project.id} closeOnClick className="ib-pmi" label={shown} data-board-project-option={project.id}>
                      <Tip content={shown} cut side="right">
                        <span className="ib-pmi-l" dir="auto">
                          {shown}
                        </span>
                      </Tip>
                      {value === project.id && <Icon name="check" size={15} className="ib-pmi-check" />}
                    </Menu.RadioItem>
                  );
                })}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {clear}
    </span>
  );
}
