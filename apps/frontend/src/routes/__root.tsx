import { createRootRouteWithContext } from "@tanstack/react-router";
import { Layout } from "../app/Layout";
import type { AppRouterContext } from "../app/router";

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: Layout,
});
