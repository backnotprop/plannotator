import { AGENT_CONFIG, type Origin } from "@plannotator/shared/agents";
import { inboxHostSessionFromEnv } from "./inbox-mcp-shim";

/**
 * Detect the calling agent from environment variables set by agent runtimes.
 * Priority:
 *   PLANNOTATOR_ORIGIN (explicit override, validated against AGENT_CONFIG)
 *   > Amp plugin wrappers (PLANNOTATOR_ORIGIN=amp)
 *   > Droid command wrappers (PLANNOTATOR_ORIGIN=droid)
 *   > Codex (CODEX_THREAD_ID)
 *   > Copilot CLI (COPILOT_CLI)
 *   > OpenCode (OPENCODE)
 *   > Gemini CLI (GEMINI_CLI)
 *   > Qwen Code (QWEN_CODE_SESSION_ID, which Qwen sets for its hooks and its
 *     shell tool; QWEN_CODE=1 is set for the shell tool only). The plan hook
 *     also knows Qwen from its payload (PermissionRequest + exit_plan_mode),
 *     and the extension's hook entry sets PLANNOTATOR_ORIGIN=qwen-code.
 *     Known limit: Qwen exports QWEN_CODE_SESSION_ID to every child, so a
 *     Claude Code started from a Qwen shell reads as Qwen here (and Qwen
 *     started from a Claude shell carries CLAUDECODE, so env alone cannot
 *     tell the nearer host).
 *   > oh-my-pi harness (OMPCODE) — checked after the runtimes above because
 *     OMP exports OMPCODE into every shell it spawns; runtimes launched from
 *     an OMP session must still be detected as themselves.
 *   > DeepSeek Harness (DSH_SHELL) — checked last of all, and skipped when the
 *     caller carries another agent's own marker. DSH sets DSH_SHELL=1 (plus
 *     DSH_SESSION_ID, DSH_HOME) in every model shell it spawns, and every
 *     process started from that shell inherits it (DSH scrubs only DSH_* and
 *     credential-shaped names from its own children, so it keeps other
 *     agents' markers too). An agent started from a DSH shell or terminal
 *     must still be detected as itself, including the agents the chain does
 *     not name (NON_DSH_AGENT_MARKERS below: Claude Code, the Claude Code
 *     mod's session tag, Pi, Cursor), which fall back to claude-code as they
 *     do outside DSH.
 *     The other way round, an agent that DSH itself was started from, is
 *     ambiguous from env alone; the agent with its own marker wins.
 *
 *   > Mistral Vibe — detected from the pre_tool hook payload (hook_event_name
 *     "pre_tool" + tool_name "exit_plan_mode" is unambiguous vs Claude/Gemini),
 *     so the installer's hook command needs no env prefix. PLANNOTATOR_ORIGIN=
 *     mistral-vibe remains the manual override above.
 *
 * To add a new agent, also add an entry to AGENT_CONFIG in
 * packages/core/agents.ts (see header comment there).
 */
export function detectOrigin(env: Record<string, string | undefined>): Origin {
  const originOverride = env.PLANNOTATOR_ORIGIN as Origin | undefined;
  return (originOverride && originOverride in AGENT_CONFIG) ? originOverride :
    env.CODEX_THREAD_ID ? "codex" :
    env.COPILOT_CLI ? "copilot-cli" :
    env.OPENCODE ? "opencode" :
    env.GEMINI_CLI ? "gemini-cli" :
    (env.QWEN_CODE_SESSION_ID || env.QWEN_CODE === "1") ? "qwen-code" :
    env.OMPCODE ? "oh-my-pi" :
    env.DSH_SHELL && !hasNonDshAgentMarker(env) ? "dsh" :
    "claude-code";
}

/**
 * Markers that agents outside the chain above set for the processes they
 * start. Any of them means an inherited DSH_SHELL is not the caller; such an
 * agent falls back to claude-code, as it did before DSH was detected.
 *   CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: Claude Code, its hooks and the Agent SDK.
 *   PI_SESSION_ID: Pi, on each bash call.
 *   CURSOR_AGENT: Cursor's agent CLI, in the shells it runs commands in
 *     (undocumented; confirmed by Cursor staff on forum.cursor.com, t/132427).
 */
const NON_DSH_AGENT_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "PI_SESSION_ID", "CURSOR_AGENT"] as const;

function hasNonDshAgentMarker(env: Record<string, string | undefined>): boolean {
  // PLANNOTATOR_SESSION_TAG: the Claude Code mod tags every process of its
  // session (`claude-code:<id>`), its detached CLI included. Counted only when
  // it is a well-formed tag, by the rule the Inbox shim uses.
  if (inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: env.PLANNOTATOR_SESSION_TAG })) return true;
  return NON_DSH_AGENT_MARKERS.some((key) => !!env[key]);
}
