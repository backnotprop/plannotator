/**
 * Plannotator TUI plugin — displays the active session URL in the opencode sidebar.
 *
 * Uses ONLY @opentui/solid's direct API (createElement, insertNode, setProp, insert).
 * insert with a plain string replaces the text content (verified by testing).
 * No solid-js imports — avoids dual solid-js instance conflicts with the host runtime.
 *
 * Host resolution mirrors @expnn/opencode-server-info's getServerAddress:
 * api.client.client.getConfig().baseUrl gives the opencode server's hostname.
 * The port comes from plannotator's URL (written to the session-url file by
 * the server plugin). The display URL is constructed as http://{host}:{port}.
 */
import { createElement, createTextNode, insertNode, setProp, insert } from "@opentui/solid";
import { readSessionUrl } from "./session-url";

/**
 * Resolve the opencode server's hostname for the TUI sidebar URL.
 *
 * TUI-specific: the TUI's `api.client` is the SDK client connected to the
 * server, and `api.state` carries the resolved opencode config. These are
 * the only sources that work in the TUI process — the server plugin uses
 * `ctx.serverUrl` (a getter on the actual listen address) instead.
 *
 * Mirrors @expnn/opencode-server-info's getServerAddress:
 * 1. SDK client config (client.client.getConfig().baseUrl)
 * 2. OPENCODE_HOST env var
 * 3. opencode.json config (state.config.server.hostname)
 * Falls back to "localhost".
 */
function getServerHostname(client: any, state?: any): string {
  // Source 1: SDK internal client config (api.client.client.getConfig())
  try {
    const internalClient = client?.client;
    const config = internalClient?.getConfig?.();
    if (config?.baseUrl) {
      const url = new URL(config.baseUrl);
      if (url.hostname) return url.hostname;
    }
  } catch { /* fall through */ }

  // Source 2: OPENCODE_HOST env var
  const envHost = process.env.OPENCODE_HOST;
  if (envHost) {
    try {
      const url = new URL(envHost);
      if (url.hostname) return url.hostname;
    } catch { /* fall through */ }
  }

  // Source 3: opencode.json config (state.config.server.hostname)
  const server = state?.config?.server;
  if (server?.hostname) return server.hostname;

  return "localhost";
}

// Minimal structural type — deliberately NOT imported from @opencode-ai/plugin/tui
// (the pinned devDep ships a different TUI API generation than the 1.18.x runtime).
interface TuiPluginApi { theme: { current: { text: string; textMuted: string } }; client: any; state: any; slots: { register(plugin: { order?: number; slots: Record<string, (ctx?: unknown, props?: { session_id?: string }) => unknown> }): void } }

const POLL_MS = 2000;

// Guard: clear the previous timer before creating a new one.
// Limits to one active timer per process (sidebar re-mount clears the old one).
let activeTimer: ReturnType<typeof setInterval> | undefined;

async function plannotatorTuiPlugin(api: TuiPluginApi) {
  const theme = api.theme.current;

  api.slots.register({
    order: 600,
    slots: {
      sidebar_content(_ctx: unknown, props?: { session_id?: string }) {
        // Structure matching opencode's built-in sidebar sections:
        //   <box>
        //     <text fg={theme.text}><b>Plannotator</b></text>
        //     <text fg={theme.textMuted}>URL</text>
        //   </box>
        // No gap — opencode sidebar sections don't use gap between title
        // and content (saves vertical space).
        const box = createElement("box");

        const titleText = createElement("text");
        setProp(titleText, "fg", theme.text);
        const b = createElement("b");
        insertNode(b, createTextNode("Plannotator"));
        insertNode(titleText, b);
        insertNode(box, titleText);

        const urlText = createElement("text");
        setProp(urlText, "fg", theme.textMuted);
        insertNode(box, urlText);

        // Poll the session-url file and construct the display URL from
        // the opencode server's hostname + plannotator's port.
        const update = () => {
          const plannotatorUrl = readSessionUrl(props?.session_id);
          if (plannotatorUrl) {
            const host = getServerHostname(api.client, api.state);
            try {
              const port = new URL(plannotatorUrl).port;
              insert(urlText, `http://${host}:${port}`);
            } catch {
              insert(urlText, plannotatorUrl);
            }
          } else {
            insert(urlText, "(no active session)");
          }
        };
        update();
        // Clear any previous timer (sidebar re-mount) to prevent accumulation.
        if (activeTimer) clearInterval(activeTimer);
        activeTimer = setInterval(update, POLL_MS);

        return box;
      },
    },
  });
}

export default {
  id: "plannotator",
  tui: plannotatorTuiPlugin,
};
