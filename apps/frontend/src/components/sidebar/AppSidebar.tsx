import { useCallback, useMemo } from "react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { Moon, Settings, Sun } from "lucide-react";
import { TaterSpriteSidebar } from "./TaterSpriteSidebar";
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
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useTheme } from "@plannotator/ui/components/ThemeProvider";
import { useDaemonEventStore } from "../../daemon/events/event-store";
import type { SessionSummary } from "../../daemon/contracts";
import { getSessionModeMeta, formatSessionLabel } from "../../shared/session-meta";

const MODE_ORDER = ["plan", "review", "annotate", "goal-setup", "archive"];

export function AppSidebarContent() {
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
    <>
      <SidebarHeader>
        <Link to="/" className="flex items-end gap-2 px-3 pt-2">
          <TaterSpriteSidebar />
          <div className="flex flex-col">
            <span
              className="text-base font-semibold tracking-tight leading-tight"
              style={{
                fontFamily: "'Instrument Sans Variable', 'Instrument Sans', system-ui, sans-serif",
              }}
            >
              Plannotator
            </span>
            <span className="text-[10px] text-muted-foreground">
              v{__APP_VERSION__} ·{" "}
              <a
                href="https://github.com/backnotprop/plannotator/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                Send feedback
              </a>
            </span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent className="pt-4">
        {MODE_ORDER.map((mode) => {
          const modeSessions = grouped.get(mode);
          if (!modeSessions?.length) return null;
          const meta = getSessionModeMeta(mode);

          const Icon = meta.icon;
          return (
            <SidebarGroup key={mode}>
              <SidebarGroupLabel>
                <Icon className="size-3.5 text-muted-foreground/60" />
                {meta.label}s
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {modeSessions.map((session) => {
                    const isActive = !!matchRoute({
                      to: "/s/$sessionId",
                      params: { sessionId: session.id },
                    });
                    const isTerminal =
                      session.status === "completed" || session.status === "cancelled";

                    return (
                      <SidebarMenuItem key={session.id}>
                        <SidebarMenuButton asChild isActive={isActive} className="h-7 pr-7 text-xs">
                          <Link to="/s/$sessionId" params={{ sessionId: session.id }}>
                            <span className="size-3.5 shrink-0" aria-hidden />
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
    </>
  );
}

export function AppSidebar() {
  return (
    <Sidebar collapsible="offcanvas">
      <AppSidebarContent />
    </Sidebar>
  );
}
