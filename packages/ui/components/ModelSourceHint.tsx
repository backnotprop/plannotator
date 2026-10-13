import type React from 'react';
import type { ModelsSource } from '@plannotator/core/model-catalog';

/** The tools whose model lists are discovered from the installed CLI. */
export type ModelSourceTool = 'claude' | 'codex';

export interface ModelSourceInfo {
  modelsSource?: ModelsSource;
  toolVersion?: string;
}

const TOOL_NAME: Record<ModelSourceTool, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** The hint tool for an Ask AI provider type (`claude-agent-sdk`, `codex-sdk`); null for the rest. */
export function modelSourceToolForProvider(providerType: string | null | undefined): ModelSourceTool | null {
  if (providerType === 'claude-agent-sdk') return 'claude';
  if (providerType === 'codex-sdk') return 'codex';
  return null;
}

/**
 * Where the model list under a picker came from. Only when the server reports
 * the tool's version: a host that does not send it gets no hint.
 */
export function modelSourceHint(tool: ModelSourceTool | null | undefined, info: ModelSourceInfo | null | undefined): string | null {
  if (!tool || !info?.toolVersion) return null;
  const name = TOOL_NAME[tool];
  if (info.modelsSource === 'discovered') return `From your installed ${name} ${info.toolVersion}`;
  if (info.modelsSource === 'fallback') return `Using the built-in list — update or sign in to ${name} to see its latest models`;
  return null;
}

/** A muted line under a model picker; renders nothing when there is no hint. */
export const ModelSourceHint: React.FC<{
  tool: ModelSourceTool | null | undefined;
  info: ModelSourceInfo | null | undefined;
  className?: string;
}> = ({ tool, info, className }) => {
  const text = modelSourceHint(tool, info);
  if (!text) return null;
  return (
    <p data-model-source-hint={info?.modelsSource} className={className}>
      {text}
    </p>
  );
};
