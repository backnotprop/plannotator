export * from '@plannotator/ui/components/inbox-thread/Tip';

export function ProjectTipText({ name, root }: { name: string; root: string }) {
  return (
    <span className="ib-tip-proj" data-project-tip="">
      <bdi className="ib-tip-name">{name}</bdi>
      <span className="ib-tip-path" dir="ltr">
        {root}
      </span>
    </span>
  );
}
