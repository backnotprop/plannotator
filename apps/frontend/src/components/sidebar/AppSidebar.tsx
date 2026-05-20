import { useCallback, useMemo } from "react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { Check, FolderPlus, Moon, Settings, Sun } from "lucide-react";
import { appStore } from "../../stores/app-store";
import { cn } from "@/lib/utils";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useTheme } from "@plannotator/ui/components/ThemeProvider";
import { useDaemonEventStore } from "../../daemon/events/event-store";
import type { SessionSummary } from "../../daemon/contracts";
import { getSessionModeMeta, formatSessionLabel } from "../../shared/session-meta";

const MODE_ORDER = ["plan", "review", "annotate", "goal-setup", "archive"];

interface AppSidebarProps {
  onAddProject: () => void;
}

export function AppSidebar({ onAddProject }: AppSidebarProps) {
  const sessions = useDaemonEventStore((s) => s.sessions);
  const { resolvedMode, setMode } = useTheme();
  const matchRoute = useMatchRoute();

  const grouped = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const list = map.get(s.mode) ?? [];
      list.push(s);
      map.set(s.mode, list);
    }
    return map;
  }, [sessions]);

  const toggleTheme = useCallback(() => {
    setMode(resolvedMode === "dark" ? "light" : "dark");
  }, [resolvedMode, setMode]);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground text-xs font-bold">
                  P
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">Plannotator</span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {sessions.length} session{sessions.length !== 1 ? "s" : ""}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {MODE_ORDER.map((mode) => {
          const modeSessions = grouped.get(mode);
          if (!modeSessions?.length) return null;
          const meta = getSessionModeMeta(mode);

          return (
            <SidebarGroup key={mode}>
              <SidebarGroupLabel>{meta.label}s</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {modeSessions.map((session) => {
                    const Icon = meta.icon;
                    const isActive = !!matchRoute({
                      to: "/s/$sessionId",
                      params: { sessionId: session.id },
                    });
                    const isTerminal =
                      session.status === "completed" || session.status === "cancelled";

                    return (
                      <SidebarMenuItem key={session.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={isActive}
                          tooltip={session.label}
                          className="pr-7"
                        >
                          <Link to="/s/$sessionId" params={{ sessionId: session.id }}>
                            <Icon
                              className={cn(
                                isTerminal && "text-muted-foreground/40",
                                session.status === "active" && !isActive && "text-primary",
                              )}
                            />
                            <span
                              className={cn(
                                "truncate",
                                isTerminal && "text-muted-foreground/60 line-through",
                              )}
                            >
                              {formatSessionLabel(session.label, session.mode)}
                            </span>
                          </Link>
                        </SidebarMenuButton>
                        {session.status === "active" && (
                          <SidebarMenuBadge>
                            <span className="h-2 w-2 rounded-full bg-primary" />
                          </SidebarMenuBadge>
                        )}
                        {isTerminal && (
                          <SidebarMenuBadge>
                            <Check className="h-3 w-3 text-muted-foreground/40" />
                          </SidebarMenuBadge>
                        )}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onAddProject} tooltip="Add project">
              <FolderPlus />
              <span>Add project</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => appStore.getState().setSettingsOpen(true)}
              tooltip="Settings"
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={toggleTheme} tooltip="Toggle theme">
              {resolvedMode === "dark" ? <Sun /> : <Moon />}
              <span>Toggle theme</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
