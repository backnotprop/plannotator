import type { ReactNode } from "react";

import { AppRailBand } from "./AppRailBand";

export function AppRail({
  variant = "default",
  leading,
  account,
  children,
}: {
  variant?: "default" | "dense";
  leading?: ReactNode;
  account?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <AppRailBand variant={variant}>
      {leading}
      {children}
      <span data-page-account="" className="flex shrink-0 pl-1 max-md:order-1 max-md:ml-auto">
        {account}
      </span>
    </AppRailBand>
  );
}
