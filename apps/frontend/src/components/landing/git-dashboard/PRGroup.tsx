import type { LucideIcon } from "lucide-react";

interface PRGroupProps {
  id?: string;
  title: string;
  icon: LucideIcon;
  count: number;
  children: React.ReactNode;
}

export function PRGroup({ id, title, icon: Icon, count, children }: PRGroupProps) {
  return (
    <div id={id} className="mt-4 first:mt-0">
      <div className="sticky -top-px z-10 flex items-center gap-2 rounded-lg bg-card px-1 py-2">
        <Icon size={13} className="text-muted-foreground/60" />
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <span className="rounded-full bg-surface-1 px-1.5 py-px text-[10px] tabular-nums text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}
