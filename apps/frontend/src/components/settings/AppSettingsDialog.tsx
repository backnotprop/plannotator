import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useAppStore } from "../../stores/app-store";
import { GeneralTab } from "@plannotator/ui/components/settings/GeneralTab";
import { PlanGeneralTab } from "@plannotator/ui/components/settings/PlanGeneralTab";
import { PlanDisplayTab } from "@plannotator/ui/components/settings/PlanDisplayTab";
import { SavingTab } from "@plannotator/ui/components/settings/SavingTab";
import { LabelsTab } from "@plannotator/ui/components/settings/LabelsTab";
import { FilesTab } from "@plannotator/ui/components/settings/FilesTab";
import { GitTab, ReviewDisplayTab, CommentsTab } from "@plannotator/ui/components/Settings";
import { ThemeTab } from "@plannotator/ui/components/ThemeTab";
import { KeyboardShortcuts } from "@plannotator/ui/components/KeyboardShortcuts";
import { AISettingsTab } from "@plannotator/ui/components/AISettingsTab";
import { HooksTab } from "@plannotator/ui/components/settings/HooksTab";
import { getAIProviderSettings, saveAIProviderSettings } from "@plannotator/ui/utils/aiProvider";
import { configStore } from "@plannotator/ui/config";

interface TabDef {
  id: string;
  label: string;
}

const GENERAL_TABS: TabDef[] = [
  { id: "general", label: "General" },
  { id: "theme", label: "Theme" },
  { id: "shortcuts", label: "Shortcuts" },
];

const PLAN_TABS: TabDef[] = [
  { id: "plan-general", label: "General" },
  { id: "plan-display", label: "Display" },
  { id: "plan-saving", label: "Saving" },
  { id: "plan-labels", label: "Labels" },
  { id: "plan-hooks", label: "Hooks" },
];

const REVIEW_TABS: TabDef[] = [
  { id: "review-git", label: "Git" },
  { id: "review-display", label: "Display" },
  { id: "review-comments", label: "Comments" },
  { id: "review-ai", label: "AI" },
];


function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

export function AppSettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const [activeTab, setActiveTab] = useState("general");
  const [themePreview, setThemePreview] = useState(false);

  useEffect(() => {
    if (!themePreview) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setThemePreview(false);
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [themePreview, setOpen]);

  // Force re-mount of tab content when dialog opens to ensure fresh state
  const [mountKey, setMountKey] = useState(0);
  useEffect(() => {
    if (open) setMountKey((k) => k + 1);
  }, [open]);

  // Detect origin from the active session (if any)
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const visitedSessions = useAppStore((s) => s.visitedSessions);
  const activeOrigin = activeSessionId
    ? ((visitedSessions[activeSessionId]?.bootstrap.session.origin as string | undefined) ?? null)
    : null;

  // Fetch git user and config from daemon on open
  const [gitUser, setGitUser] = useState<string | undefined>();
  const [legacyTabMode, setLegacyTabMode] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch("/daemon/git/user")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.gitUser) setGitUser(data.gitUser);
      })
      .catch(() => {});
    fetch("/daemon/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.config) {
          configStore.init(data.config);
          setLegacyTabMode(!!data.config.legacyTabMode);
        }
      })
      .catch(() => {});
  }, [open]);

  // Daemon-routed fetch for tabs that need server calls without session context
  const daemonFetch = useCallback((input: string, init?: RequestInit) => {
    const path =
      typeof input === "string" && input.startsWith("/api/") ? `/daemon${input.slice(4)}` : input;
    return fetch(path, init);
  }, []);

  // AI provider state — fetched once when dialog opens
  const [aiProviders, setAiProviders] = useState<
    Array<{ id: string; name: string; capabilities: Record<string, boolean> }>
  >([]);
  const [aiProviderId, setAiProviderId] = useState<string | null>(
    () => getAIProviderSettings().providerId,
  );

  // Re-read AI provider on each open (could have changed via per-surface settings)
  useEffect(() => {
    if (open) setAiProviderId(getAIProviderSettings().providerId);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const apiBase = activeSessionId ? `/s/${activeSessionId}/api` : null;
    if (!apiBase) return;
    fetch(`${apiBase}/ai/capabilities`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.providers) setAiProviders(data.providers);
      })
      .catch(() => {});
  }, [open, activeSessionId]);

  const handleAiProviderChange = useCallback((providerId: string | null) => {
    setAiProviderId(providerId);
    const current = getAIProviderSettings();
    saveAIProviderSettings({ ...current, providerId });
  }, []);

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-0" hideClose>
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <Tabs
            key={mountKey}
            value={activeTab}
            onValueChange={setActiveTab}
            orientation="vertical"
            className="flex h-[min(600px,80vh)]"
          >
            <div className="flex w-44 shrink-0 flex-col border-r border-border">
              <div className="px-4 pb-1 pt-4">
                <span className="text-sm font-semibold">Settings</span>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>v{__APP_VERSION__}</span>
                  <span>·</span>
                  <a
                    href="https://github.com/backnotprop/plannotator/issues"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-foreground"
                  >
                    Send feedback
                  </a>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-2 py-2">
                <TabsList className="flex-col gap-0.5">
                  <SectionLabel>General</SectionLabel>
                  {GENERAL_TABS.map((tab) => (
                    <TabsTrigger key={tab.id} value={tab.id} className="w-full justify-start h-8">
                      {tab.label}
                    </TabsTrigger>
                  ))}

                  <SectionLabel>Plan Review</SectionLabel>
                  {PLAN_TABS.map((tab) => (
                    <TabsTrigger key={tab.id} value={tab.id} className="w-full justify-start h-8">
                      {tab.label}
                    </TabsTrigger>
                  ))}

                  <SectionLabel>Code Review</SectionLabel>
                  {REVIEW_TABS.map((tab) => (
                    <TabsTrigger key={tab.id} value={tab.id} className="w-full justify-start h-8">
                      {tab.label}
                    </TabsTrigger>
                  ))}

                  <TabsTrigger value="int-files" className="w-full justify-start h-8">
                    Files
                  </TabsTrigger>
                </TabsList>
              </div>
            </div>

            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex shrink-0 items-center justify-end border-b border-border px-4 py-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-5">
                {/* General */}
                <TabsContent value="general">
                  <GeneralTab
                    gitUser={gitUser}
                    legacyTabMode={legacyTabMode}
                    onLegacyTabModeChange={(enabled) => {
                      setLegacyTabMode(enabled);
                      fetch("/daemon/config", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ legacyTabMode: enabled }),
                      }).catch(() => {});
                    }}
                  />
                </TabsContent>
                <TabsContent value="theme">
                  <ThemeTab
                    onPreview={() => {
                      setOpen(false);
                      setThemePreview(true);
                    }}
                  />
                </TabsContent>
                <TabsContent value="shortcuts">
                  <div className="space-y-6">
                    <div>
                      <div className="mb-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Plan Review
                      </div>
                      <KeyboardShortcuts mode="plan" />
                    </div>
                    <div className="border-t border-border pt-6">
                      <div className="mb-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Code Review
                      </div>
                      <KeyboardShortcuts mode="review" />
                    </div>
                  </div>
                </TabsContent>

                {/* Plan Review */}
                <TabsContent value="plan-general">
                  <PlanGeneralTab origin={activeOrigin} />
                </TabsContent>
                <TabsContent value="plan-display">
                  <PlanDisplayTab />
                </TabsContent>
                <TabsContent value="plan-saving">
                  <SavingTab />
                </TabsContent>
                <TabsContent value="plan-labels">
                  <LabelsTab />
                </TabsContent>
                <TabsContent value="plan-hooks">
                  <HooksTab fetchFn={daemonFetch} />
                </TabsContent>

                {/* Code Review */}
                <TabsContent value="review-git">
                  <GitTab />
                </TabsContent>
                <TabsContent value="review-display">
                  <ReviewDisplayTab />
                </TabsContent>
                <TabsContent value="review-comments">
                  <CommentsTab />
                </TabsContent>
                <TabsContent value="review-ai">
                  <AISettingsTab
                    providers={aiProviders}
                    selectedProviderId={aiProviderId}
                    onProviderChange={handleAiProviderChange}
                  />
                </TabsContent>

                <TabsContent value="int-files">
                  <FilesTab />
                </TabsContent>
              </div>
            </div>
          </Tabs>
        </DialogContent>
      </Dialog>

      {themePreview &&
        createPortal(
          <div className="fixed inset-0 z-[110] flex flex-col pointer-events-none">
            <div className="flex-1" />
            <div className="pointer-events-auto w-full bg-card border-t-2 border-primary/30 shadow-[0_-4px_20px_rgba(0,0,0,0.4)] flex flex-col max-h-[35vh] overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b border-border">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Theme Preview
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setThemePreview(false);
                    setOpen(true);
                  }}
                  className="px-3 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  Done
                </button>
              </div>
              <div className="p-3 overflow-y-auto flex-1 min-h-0">
                <ThemeTab compact />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
