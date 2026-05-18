import type { ReactNode } from "react";
import { AnnotateSessionView } from "../annotate/AnnotateSessionView";
import { ArchiveSessionView } from "../archive/ArchiveSessionView";
import type { ShellSessionBootstrap, ShellSessionMode } from "./types";
import { PlanSessionView } from "../plan/PlanSessionView";
import { ReviewSessionView } from "../review/ReviewSessionView";
import { SetupGoalSessionView } from "../setup-goal/SetupGoalSessionView";

export interface SessionViewComponentProps {
  bootstrap: ShellSessionBootstrap;
}

export type SessionViewComponent = (props: SessionViewComponentProps) => ReactNode;

export interface SessionViewDefinition {
  mode: ShellSessionMode;
  title: string;
  component: SessionViewComponent;
}

const registry: Record<string, SessionViewDefinition> = {
  plan: {
    mode: "plan",
    title: "Plan review",
    component: PlanSessionView,
  },
  review: {
    mode: "review",
    title: "Code review",
    component: ReviewSessionView,
  },
  annotate: {
    mode: "annotate",
    title: "Annotate",
    component: AnnotateSessionView,
  },
  archive: {
    mode: "archive",
    title: "Archive",
    component: ArchiveSessionView,
  },
  "setup-goal": {
    mode: "setup-goal",
    title: "Setup goal",
    component: SetupGoalSessionView,
  },
};

export function getSessionViewDefinition(
  mode: ShellSessionMode,
): SessionViewDefinition | undefined {
  return registry[mode];
}

export function supportedSessionModes(): ShellSessionMode[] {
  return Object.keys(registry);
}
