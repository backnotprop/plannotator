import { createRootRouteWithContext } from "@tanstack/react-router";
import { ShellLayout } from "../app/layout/ShellLayout";
import type { AppRouterContext } from "../app/router";

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: ShellLayout,
});
