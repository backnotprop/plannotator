import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentTerminalAgent,
  AgentTerminalCapability,
} from "@plannotator/shared/agent-terminal";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@plannotator/ui/components/Popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@plannotator/ui/components/ui/dropdown-menu";
import {
  getSavedAnnotateAgentId,
  resolveAgentTerminalWebSocketUrl,
  resolveAnnotateAgentId,
  saveAnnotateAgentId,
} from "@plannotator/ui/utils/annotateAgentTerminal";
import { getItem, setItem } from "@plannotator/ui/utils/storage";
import { WebSocketPtyBackend } from "@plannotator/webtui/browser";
import { WebTuiTerminal } from "@plannotator/webtui/react";
import type { PtyBackend, PtyExit, PtySpawnOptions } from "@plannotator/webtui/core";
import type { WebTuiSession } from "@plannotator/webtui/browser";
import {
  Check,
  ChevronDown,
  Minus,
  Play,
  Plus,
  RotateCcw,
  Settings as SettingsIcon,
} from "lucide-react";
import { useAnnotateAgentTerminalTheme } from "./annotateAgentTerminalTheme";

export type AnnotateAgentTerminalPanelHandle = {
  stop(): void;
  sendMessage(message: string): boolean;
};

type TerminalStatus = "idle" | "starting" | "running" | "stopping" | "exited";
type AgentTerminalFontFamily = "theme" | "system" | "geist";
type AgentTerminalFontWeight = "light" | "regular" | "medium";

type AgentTerminalDisplaySettings = {
  fontFamily: AgentTerminalFontFamily;
  fontSize: number;
  fontWeight: AgentTerminalFontWeight;
  lineHeight: number;
};

interface AnnotateAgentTerminalPanelProps {
  capability: AgentTerminalCapability;
  width: number | string;
  onSessionActiveChange?: (active: boolean) => void;
  onSessionReadyChange?: (ready: boolean) => void;
  onClose: () => void;
}

const DISPLAY_STORAGE_KEY = "plannotator-agent-terminal-display";
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

const DEFAULT_DISPLAY_SETTINGS: AgentTerminalDisplaySettings = {
  fontFamily: "theme",
  fontSize: 14,
  fontWeight: "regular",
  lineHeight: 1,
};

const FONT_FAMILY_OPTIONS: {
  value: AgentTerminalFontFamily;
  label: string;
  family: string | null;
}[] = [
  { value: "theme", label: "Theme", family: null },
  {
    value: "system",
    label: "System mono",
    family:
      '"SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, ui-monospace, monospace',
  },
  {
    value: "geist",
    label: "Geist Mono",
    family: '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace',
  },
];

const FONT_WEIGHT_OPTIONS: {
  value: AgentTerminalFontWeight;
  label: string;
  fontWeight: number;
  fontWeightBold: number;
}[] = [
  { value: "light", label: "Light", fontWeight: 300, fontWeightBold: 600 },
  { value: "regular", label: "Regular", fontWeight: 400, fontWeightBold: 700 },
  { value: "medium", label: "Medium", fontWeight: 500, fontWeightBold: 700 },
];

const LINE_HEIGHT_OPTIONS = [1, 1.1, 1.2, 1.35];
const AGENT_TERMINAL_FONT_ZOOM = {
  enabled: true,
  min: MIN_FONT_SIZE,
  max: MAX_FONT_SIZE,
  step: 1,
  defaultSize: DEFAULT_DISPLAY_SETTINGS.fontSize,
};

export const AnnotateAgentTerminalPanel = forwardRef<
  AnnotateAgentTerminalPanelHandle,
  AnnotateAgentTerminalPanelProps
>(function AnnotateAgentTerminalPanel({ capability, width, onSessionActiveChange, onSessionReadyChange, onClose }, ref) {
  const agents = capability.enabled ? capability.agents : [];
  const availableAgents = useMemo(
    () => agents.filter((agent) => agent.available),
    [agents],
  );
  const wsUrl = capability.enabled
    ? resolveAgentTerminalWebSocketUrl(capability.wsPath)
    : "";
  const backend = useMemo(
    () => (wsUrl ? createAgentOnlyBackend(wsUrl) : null),
    [wsUrl],
  );
  const initialAgentId = useMemo(
    () => resolveAnnotateAgentId(agents, getSavedAnnotateAgentId()),
    [agents],
  );
  const [selectedAgentId, setSelectedAgentId] = useState(initialAgentId);
  const [saveAsDefault, setSaveAsDefault] = useState(
    () => getSavedAnnotateAgentId() === initialAgentId,
  );
  const [startedAgentId, setStartedAgentId] = useState<string | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("idle");
  const [exitLabel, setExitLabel] = useState<string | null>(null);
  const [displaySettings, setDisplaySettings] = useState(readDisplaySettings);
  const sessionRef = useRef<WebTuiSession | null>(null);
  const closeAfterStopRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const timersRef = useRef<number[]>([]);
  const terminalTheme = useAnnotateAgentTerminalTheme();

  useEffect(() => {
    setSelectedAgentId((current) => {
      if (availableAgents.some((agent) => agent.id === current)) return current;
      return initialAgentId;
    });
  }, [availableAgents, initialAgentId]);

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
  }, []);

  const hardStop = useCallback(() => {
    clearTimers();
    stopRequestedRef.current = false;
    sessionRef.current?.pty.kill();
    sessionRef.current = null;
    onSessionActiveChange?.(false);
    onSessionReadyChange?.(false);
  }, [clearTimers, onSessionActiveChange, onSessionReadyChange]);

  useEffect(() => {
    return () => {
      hardStop();
    };
  }, [hardStop]);

  const terminalOptions = useMemo(() => {
    const weight = resolveDisplayWeight(displaySettings.fontWeight);
    const fontFamily = resolveDisplayFontFamily(
      displaySettings.fontFamily,
      terminalTheme.terminalOptions.fontFamily,
    );

    return {
      ...terminalTheme.terminalOptions,
      fontFamily,
      fontSize: displaySettings.fontSize,
      fontWeight: weight.fontWeight,
      fontWeightBold: weight.fontWeightBold,
      lineHeight: displaySettings.lineHeight,
    };
  }, [displaySettings, terminalTheme.terminalOptions]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.terminal.options.theme = terminalOptions.theme;
    session.terminal.options.fontFamily = terminalOptions.fontFamily;
    session.terminal.options.fontWeight = terminalOptions.fontWeight;
    session.terminal.options.fontWeightBold = terminalOptions.fontWeightBold;
    session.terminal.options.lineHeight = terminalOptions.lineHeight;
    session.setFontSize(terminalOptions.fontSize);
    session.resize();
  }, [terminalOptions]);

  const updateDisplaySettings = useCallback(
    (updates: Partial<AgentTerminalDisplaySettings>) => {
      setDisplaySettings((current) => {
        const next = sanitizeDisplaySettings({ ...current, ...updates });
        writeDisplaySettings(next);
        return next;
      });
    },
    [],
  );

  const resetDisplaySettings = useCallback(() => {
    setDisplaySettings(DEFAULT_DISPLAY_SETTINGS);
    writeDisplaySettings(DEFAULT_DISPLAY_SETTINGS);
  }, []);

  const selectedAgent =
    availableAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const canStart =
    capability.enabled &&
    !!backend &&
    !!selectedAgentId &&
    !!selectedAgent &&
    status !== "starting" &&
    status !== "running" &&
    status !== "stopping";

  const handleStart = useCallback(() => {
    if (!canStart || !selectedAgent) return;
    if (saveAsDefault) saveAnnotateAgentId(selectedAgent.id);
    stopRequestedRef.current = false;
    closeAfterStopRef.current = false;
    setExitLabel(null);
    setStartedAgentId(selectedAgent.id);
    setStatus("starting");
    onSessionActiveChange?.(true);
    onSessionReadyChange?.(false);
  }, [canStart, onSessionActiveChange, onSessionReadyChange, saveAsDefault, selectedAgent]);

  const requestStop = useCallback((closeAfterStop: boolean) => {
    stopRequestedRef.current = true;
    const session = sessionRef.current;
    if (!session) {
      if (startedAgentId) {
        closeAfterStopRef.current = closeAfterStop;
        setStatus("stopping");
        return;
      }
      clearTimers();
      stopRequestedRef.current = false;
      setStartedAgentId(null);
      setStatus("idle");
      onSessionActiveChange?.(false);
      onSessionReadyChange?.(false);
      if (closeAfterStop) onClose();
      return;
    }

    clearTimers();
    closeAfterStopRef.current = closeAfterStop;
    setStatus("stopping");
    onSessionReadyChange?.(false);
    session.write("\x03");
    timersRef.current.push(window.setTimeout(() => sessionRef.current?.write("\x03"), 350));
    timersRef.current.push(window.setTimeout(() => {
      sessionRef.current?.pty.kill();
      if (closeAfterStopRef.current) onClose();
    }, 1400));
  }, [clearTimers, onClose, onSessionActiveChange, onSessionReadyChange, startedAgentId]);

  const sendMessage = useCallback((message: string) => {
    const text = message.trim();
    const session = sessionRef.current;
    if (!text || !session) return false;
    try {
      return session.sendAgentMessage({ text });
    } catch {
      return false;
    }
  }, []);

  useImperativeHandle(ref, () => ({
    stop: () => requestStop(true),
    sendMessage,
  }), [requestStop, sendMessage]);

  const handleExit = useCallback((event: PtyExit) => {
    clearTimers();
    stopRequestedRef.current = false;
    sessionRef.current = null;
    setStartedAgentId(null);
    onSessionActiveChange?.(false);
    onSessionReadyChange?.(false);
    setExitLabel(formatExit(event));
    if (closeAfterStopRef.current) {
      closeAfterStopRef.current = false;
      onClose();
      return;
    }
    setStatus("exited");
  }, [clearTimers, onClose, onSessionActiveChange, onSessionReadyChange]);

  return (
    <aside
      data-annotate-agent-terminal="true"
      className="hidden lg:flex h-full flex-shrink-0 flex-col border-r border-border bg-card"
      style={{ width }}
    >
      {!capability.enabled ? (
        <div className="flex flex-1 flex-col justify-center gap-2 px-4 text-center">
          <p className="text-xs font-medium text-foreground">Agent unavailable</p>
          <p className="text-[11px] leading-5 text-muted-foreground">
            {capability.message ?? "WebTUI is not available in this session."}
          </p>
        </div>
      ) : startedAgentId && backend ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-10 items-center justify-between gap-2 border-b border-border/40 px-3">
            <div className="min-w-0 text-[11px] text-muted-foreground">
              <span className="text-foreground">{formatAgentName(startedAgentId, agents)}</span>
              <span className="mx-1.5 text-muted-foreground/40">in</span>
              <span className="inline-block max-w-[13rem] truncate align-bottom font-mono" title={capability.cwd}>{capability.cwd}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <AgentTerminalDisplayPopover
                settings={displaySettings}
                onChange={updateDisplaySettings}
                onReset={resetDisplaySettings}
              />
              <button
                type="button"
                aria-label="Stop agent"
                onClick={() => requestStop(false)}
                disabled={status === "stopping" || status === "exited"}
                className="h-6 shrink-0 rounded px-1.5 text-[11px] font-medium text-muted-foreground/80 transition-colors hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                Stop
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1" style={terminalTheme.shellStyle}>
            <WebTuiTerminal
              key={startedAgentId}
              backend={backend}
              cwd={capability.cwd}
              agent={startedAgentId}
              prompt={null}
              terminalOptions={terminalOptions}
              terminalColorScheme={terminalTheme.colorScheme}
              terminalGpuAcceleration="auto"
              fontZoom={AGENT_TERMINAL_FONT_ZOOM}
              className="h-full border-0"
              onReady={(session) => {
                sessionRef.current = session;
                session.terminal.options.theme = terminalOptions.theme;
                session.terminal.options.fontFamily = terminalOptions.fontFamily;
                session.terminal.options.fontWeight = terminalOptions.fontWeight;
                session.terminal.options.fontWeightBold = terminalOptions.fontWeightBold;
                session.terminal.options.lineHeight = terminalOptions.lineHeight;
                session.setFontSize(terminalOptions.fontSize);
                if (closeAfterStopRef.current || stopRequestedRef.current) {
                  requestStop(closeAfterStopRef.current);
                  return;
                }
                setStatus("running");
                onSessionReadyChange?.(true);
              }}
              onExit={handleExit}
            />
          </div>
          {exitLabel && (
            <div className="border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
              {exitLabel}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 p-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">Agent</span>
            <AgentSelect
              agents={availableAgents}
              selectedAgentId={selectedAgentId}
              onSelect={setSelectedAgentId}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={saveAsDefault}
              onChange={(event) => setSaveAsDefault(event.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            Use as default
          </label>
          <button
            type="button"
            onClick={handleStart}
            disabled={!canStart}
            className="mt-1 flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            Start
          </button>
          {availableAgents.length === 0 && (
            <p className="text-[11px] leading-5 text-muted-foreground">
              No supported agent CLI was found on PATH.
            </p>
          )}
        </div>
      )}
    </aside>
  );
});

function AgentSelect({
  agents,
  selectedAgentId,
  onSelect,
}: {
  agents: AgentTerminalAgent[];
  selectedAgentId: string;
  onSelect: (agentId: string) => void;
}) {
  const selectedAgent =
    agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Select agent"
            disabled={agents.length === 0}
            className="flex h-8 w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/50 px-2.5 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:border-primary/50 data-[popup-open]:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          />
        }
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {selectedAgent?.name ?? "Select agent"}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="z-[100] min-w-[var(--anchor-width)]"
      >
        {agents.map((agent) => {
          const selected = agent.id === selectedAgentId;
          const tone = selected ? "text-foreground" : "text-foreground/80";

          return (
            <DropdownMenuItem
              key={agent.id}
              onClick={() => onSelect(agent.id)}
              className={`h-7 text-xs ${tone}`}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {selected && <Check className="h-3 w-3" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function formatAgentName(id: string, agents: { id: string; name: string }[]): string {
  return agents.find((agent) => agent.id === id)?.name ?? id;
}

function createAgentOnlyBackend(wsUrl: string): PtyBackend {
  const backend = new WebSocketPtyBackend(wsUrl);
  return {
    spawn(options) {
      return backend.spawn(buildAgentOnlySpawnOptions(options));
    },
  };
}

function buildAgentOnlySpawnOptions(options: PtySpawnOptions): PtySpawnOptions {
  const spawnOptions: PtySpawnOptions = {};
  if (options.agent) spawnOptions.agent = options.agent;
  const cols = normalizeTerminalDimension(options.cols);
  if (cols !== undefined) spawnOptions.cols = cols;
  const rows = normalizeTerminalDimension(options.rows);
  if (rows !== undefined) spawnOptions.rows = rows;
  return spawnOptions;
}

function normalizeTerminalDimension(value: unknown): number | undefined {
  if (!Number.isInteger(value) || (value as number) <= 0) return undefined;
  return Math.min(value as number, 1_000);
}

function formatExit(event: PtyExit): string {
  if (event.signal) return `Stopped (${event.signal})`;
  if (event.exitCode === null) return "Stopped";
  return `Exited ${event.exitCode}`;
}

function AgentTerminalDisplayPopover({
  settings,
  onChange,
  onReset,
}: {
  settings: AgentTerminalDisplaySettings;
  onChange: (updates: Partial<AgentTerminalDisplaySettings>) => void;
  onReset: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Terminal display settings"
            title="Display settings"
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground/80 transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:bg-primary/15 data-[popup-open]:text-primary"
          />
        }
      >
        <SettingsIcon className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-64 p-2.5">
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-foreground">Display</div>
            <button
              type="button"
              aria-label="Reset terminal display settings"
              onClick={onReset}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>

          <TerminalDisplayStepper
            label="Font size"
            value={settings.fontSize}
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            suffix="px"
            onChange={(fontSize) => onChange({ fontSize })}
          />

          <label className="flex items-center justify-between gap-3 py-1">
            <span className="text-[11px] text-muted-foreground">Font</span>
            <select
              value={settings.fontFamily}
              onChange={(event) =>
                onChange({ fontFamily: event.target.value as AgentTerminalFontFamily })
              }
              className="h-7 w-32 rounded-md border border-border bg-background px-2 text-[11px] text-foreground outline-none transition-colors focus:border-primary"
            >
              {FONT_FAMILY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <TerminalDisplaySegmented
            label="Weight"
            value={settings.fontWeight}
            options={FONT_WEIGHT_OPTIONS.map(({ value, label }) => ({ value, label }))}
            onChange={(fontWeight) => onChange({ fontWeight })}
          />

          <TerminalDisplaySegmented
            label="Line height"
            value={String(settings.lineHeight)}
            options={LINE_HEIGHT_OPTIONS.map((lineHeight) => ({
              value: String(lineHeight),
              label: lineHeight.toFixed(lineHeight === 1 ? 0 : 2).replace(/0$/, ""),
            }))}
            onChange={(value) => onChange({ lineHeight: Number(value) })}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function TerminalDisplayStepper({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  const clamped = clampNumber(value, min, max);
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-px rounded-md bg-muted/60 p-px">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(clamped - 1)}
          disabled={clamped <= min}
          className="flex h-6 w-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Minus className="h-3 w-3" />
        </button>
        <span className="w-12 text-center text-[11px] tabular-nums text-foreground">
          {clamped}
          {suffix}
        </span>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => onChange(clamped + 1)}
          disabled={clamped >= max}
          className="flex h-6 w-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function TerminalDisplaySegmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="flex items-center gap-px rounded-md bg-muted/60 p-px">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`h-6 flex-1 rounded-[5px] px-2 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
              value === option.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function readDisplaySettings(): AgentTerminalDisplaySettings {
  const raw = getItem(DISPLAY_STORAGE_KEY);
  if (!raw) return DEFAULT_DISPLAY_SETTINGS;
  try {
    return sanitizeDisplaySettings(JSON.parse(raw));
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
}

function writeDisplaySettings(settings: AgentTerminalDisplaySettings): void {
  setItem(DISPLAY_STORAGE_KEY, JSON.stringify(settings));
}

function sanitizeDisplaySettings(value: unknown): AgentTerminalDisplaySettings {
  const partial = isRecord(value) ? value : {};
  return {
    fontFamily: isFontFamily(partial.fontFamily)
      ? partial.fontFamily
      : DEFAULT_DISPLAY_SETTINGS.fontFamily,
    fontSize: clampNumber(
      typeof partial.fontSize === "number" ? partial.fontSize : DEFAULT_DISPLAY_SETTINGS.fontSize,
      MIN_FONT_SIZE,
      MAX_FONT_SIZE,
    ),
    fontWeight: isFontWeight(partial.fontWeight)
      ? partial.fontWeight
      : DEFAULT_DISPLAY_SETTINGS.fontWeight,
    lineHeight: LINE_HEIGHT_OPTIONS.includes(partial.lineHeight as number)
      ? (partial.lineHeight as number)
      : DEFAULT_DISPLAY_SETTINGS.lineHeight,
  };
}

function resolveDisplayFontFamily(
  fontFamily: AgentTerminalFontFamily,
  themeFontFamily: string | undefined,
): string | undefined {
  const option = FONT_FAMILY_OPTIONS.find((item) => item.value === fontFamily);
  return option?.family ?? themeFontFamily;
}

function resolveDisplayWeight(fontWeight: AgentTerminalFontWeight): {
  fontWeight: number;
  fontWeightBold: number;
} {
  return (
    FONT_WEIGHT_OPTIONS.find((item) => item.value === fontWeight) ??
    FONT_WEIGHT_OPTIONS[1]
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFontFamily(value: unknown): value is AgentTerminalFontFamily {
  return typeof value === "string" && FONT_FAMILY_OPTIONS.some((item) => item.value === value);
}

function isFontWeight(value: unknown): value is AgentTerminalFontWeight {
  return typeof value === "string" && FONT_WEIGHT_OPTIONS.some((item) => item.value === value);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
