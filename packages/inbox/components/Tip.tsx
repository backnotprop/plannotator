/**
 * Tip moved to @plannotator/ui (packages/ui/components/inbox-thread/Tip.tsx) unchanged, so a
 * host of the shared thread parts opens the same tooltips. This path re-exports it so every
 * existing import and test keeps working. A project's tooltip stays here: the sidebar, the
 * list and search draw it, no thread part does.
 */
export * from '@plannotator/ui/components/inbox-thread/Tip';

/** A project's tooltip: its whole name (a row may cut it) over its folder, which no row shows. */
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
