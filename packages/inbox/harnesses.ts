/**
 * "Connect an agent": one verified way to add the Inbox's MCP server per
 * harness, from research/findings/MCP-ADD-METHODS-2026-10-07.md (vendor docs
 * read 2026-10-07), in the shape of Workspaces' ConnectAgentSheet. Every
 * artefact names the stdio entry with the CLI's absolute path, which the
 * server reports (`mcp_command`), so apps started from the Dock that do not
 * see the shell PATH still find it. Pure.
 */

export type HarnessId =
  | 'claude-code'
  | 'claude-app'
  | 'codex'
  | 'cursor'
  | 'vscode'
  | 'windsurf'
  | 'gemini'
  | 'goose'
  | 'amp'
  | 'cline'
  | 'pi'
  | 'opencode'
  | 'zed'
  | 'kiro'
  | 'jetbrains'
  | 'other';

export interface Harness {
  id: HarnessId;
  label: string;
}

/** The picker's order (the research record's), Claude Code first. */
export const HARNESSES: readonly Harness[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-app', label: 'Claude app' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'windsurf', label: 'Windsurf / Devin' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'goose', label: 'Goose' },
  { id: 'amp', label: 'Amp' },
  { id: 'cline', label: 'Cline' },
  { id: 'pi', label: 'Pi' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'zed', label: 'Zed' },
  { id: 'kiro', label: 'Kiro' },
  { id: 'jetbrains', label: 'JetBrains' },
  { id: 'other', label: 'Other MCP client' },
];

/** The empty state's "Any other agent" tabs: the three Plannotator hosts have their own cards above. */
export const OTHER_HARNESSES: readonly Harness[] = HARNESSES.filter(
  (h) => h.id !== 'claude-code' && h.id !== 'pi' && h.id !== 'opencode',
);

export type Artefact =
  | { kind: 'code'; text: string; label?: string }
  | { kind: 'link'; label: string; href: string };

export interface HarnessPanel {
  lead: string;
  artefacts: Artefact[];
  after?: string;
  another?: { summary: string; body?: Artefact };
  note?: string;
}

export interface ConnectContext {
  /** The stdio entry as argv: `[<absolute CLI>, "inbox", "mcp"]`. */
  command: readonly string[];
  /** `http://127.0.0.1:<port>/mcp`. */
  mcpUrl: string;
  /** For the Claude app's config path. */
  platform: 'mac' | 'windows' | 'linux';
}

const SERVER = 'plannotator-inbox';

/** POSIX single-quoting where a word needs it; plain words stay bare. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_\-./:=@%+,~]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function shellLine(words: readonly string[]): string {
  return words.map(shellWord).join(' ');
}

function stdio(ctx: ConnectContext): { command: string; args: string[] } {
  const [command = 'plannotator', ...args] = ctx.command;
  return { command, args };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function mcpServersSnippet(ctx: ConnectContext): string {
  return json({ mcpServers: { [SERVER]: stdio(ctx) } });
}

/** base64 of UTF-8 text, browser and Bun alike. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Cursor's documented install link: the single server's JSON, base64, no mcpServers wrapper. */
export function cursorInstallLink(ctx: ConnectContext): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER}&config=${encodeURIComponent(base64(JSON.stringify(stdio(ctx))))}`;
}

/** VS Code's documented install link: `{ name, ...server config }`, URI-encoded. */
export function vscodeInstallLink(ctx: ConnectContext): string {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER, type: 'stdio', ...stdio(ctx) }))}`;
}

/** Goose's documented extension link: `cmd` plus one `arg` per argument. */
export function gooseInstallLink(ctx: ConnectContext): string {
  const { command, args } = stdio(ctx);
  const params = [`cmd=${encodeURIComponent(command)}`, ...args.map((a) => `arg=${encodeURIComponent(a)}`)];
  params.push(`id=${SERVER}`, 'name=Plannotator%20Inbox', 'description=Plannotator%20Inbox', 'timeout=300');
  return `goose://extension?${params.join('&')}`;
}

/** The "Prefer the MCP? Add it anyway" line under each Plannotator host's card. */
export function hostMcpSnippet(host: 'claude-code' | 'pi' | 'opencode', ctx: ConnectContext): string {
  const cmd = shellLine(ctx.command);
  if (host === 'claude-code') return `claude mcp add --scope user ${SERVER} -- ${cmd}`;
  if (host === 'pi') return `pi mcp add ${SERVER} -- ${cmd}`;
  return `opencode.json: "mcp": { "${SERVER}": { "type": "local", "command": ${JSON.stringify([...ctx.command])}, "enabled": true } }`;
}

export function harnessPanel(id: HarnessId, ctx: ConnectContext): HarnessPanel {
  const cmd = shellLine(ctx.command);
  switch (id) {
    case 'claude-code':
      return {
        lead: "Run this in a terminal. It covers the terminal and the Claude app's Code tab, in every project.",
        artefacts: [{ kind: 'code', text: hostMcpSnippet('claude-code', ctx) }],
        after: "Not needed with Plannotator's Claude Code plugin: its mod already writes here.",
        another: {
          summary: 'the HTTP address, if you prefer it',
          body: { kind: 'code', text: `claude mcp add --scope user --transport http ${SERVER} ${ctx.mcpUrl}` },
        },
      };
    case 'claude-app':
      return {
        lead: "Add this to Claude's config file. Open it from the Claude menu > Settings > Developer > Edit Config.",
        artefacts: [
          {
            kind: 'code',
            label:
              ctx.platform === 'windows'
                ? '%APPDATA%\\Claude\\claude_desktop_config.json'
                : '~/Library/Application Support/Claude/claude_desktop_config.json',
            text: mcpServersSnippet(ctx),
          },
        ],
        after: 'Merge it into an existing "mcpServers" if there is one. Then quit Claude completely and reopen it. The Code tab picks it up too.',
        note: 'Custom connectors on claude.ai cannot reach this computer, so this file is the way in.',
      };
    case 'codex':
      return {
        lead: 'Run this in a terminal. It also adds the Inbox to the Codex app and the IDE extension, which share its config.',
        artefacts: [{ kind: 'code', text: `codex mcp add ${SERVER} -- ${cmd}` }],
        after: 'Then restart the Codex app or the IDE extension if one is open.',
        another: { summary: 'in the Codex app: Settings > MCP servers > Add server > STDIO, then Restart' },
      };
    case 'cursor':
      return {
        lead: 'Opens Cursor and asks it to add the Inbox as a local server.',
        artefacts: [{ kind: 'link', label: 'Add to Cursor', href: cursorInstallLink(ctx) }],
        after: "Cursor asks before it uses the Inbox's tools the first time.",
        another: { summary: 'add it to ~/.cursor/mcp.json by hand', body: { kind: 'code', label: '~/.cursor/mcp.json', text: mcpServersSnippet(ctx) } },
      };
    case 'vscode':
      return {
        lead: 'Opens VS Code and asks it to add the Inbox to your user profile.',
        artefacts: [{ kind: 'link', label: 'Install in VS Code', href: vscodeInstallLink(ctx) }],
        after: 'VS Code asks you to trust the server the first time it starts.',
        another: {
          summary: 'run code --add-mcp in a terminal',
          body: { kind: 'code', text: `code --add-mcp ${shellWord(JSON.stringify({ name: SERVER, type: 'stdio', ...stdio(ctx) }))}` },
        },
      };
    case 'windsurf':
      return {
        lead: 'Run this in a terminal. It adds the Inbox to Devin Desktop (formerly Windsurf) in every project.',
        artefacts: [{ kind: 'code', text: `devin mcp add -s user ${SERVER} -- ${cmd}` }],
        another: {
          summary: 'add it to ~/.config/devin/mcp_config.json by hand',
          body: { kind: 'code', label: '~/.config/devin/mcp_config.json', text: mcpServersSnippet(ctx) },
        },
      };
    case 'gemini':
      return {
        lead: 'Run this in a terminal. It adds the Inbox to Gemini CLI in every project.',
        artefacts: [{ kind: 'code', text: `gemini mcp add -s user ${SERVER} ${cmd}` }],
      };
    case 'goose':
      return {
        lead: 'Opens Goose and asks it to add the Inbox as an extension.',
        artefacts: [{ kind: 'link', label: 'Add to Goose', href: gooseInstallLink(ctx) }],
        another: {
          summary: 'in Goose: Extensions > Add custom extension > Standard IO, with this command',
          body: { kind: 'code', text: cmd },
        },
      };
    case 'amp':
      return {
        lead: 'Run this in a terminal.',
        artefacts: [{ kind: 'code', text: `amp mcp add ${SERVER} -- ${cmd}` }],
      };
    case 'cline':
      return {
        lead: 'Run this in a terminal for the Cline CLI.',
        artefacts: [{ kind: 'code', text: `cline mcp add ${SERVER} --yes -- ${cmd}` }],
        another: {
          summary: 'in the Cline extension: MCP Servers > Configure > Configure MCP Servers, then paste this',
          body: { kind: 'code', text: mcpServersSnippet(ctx) },
        },
      };
    case 'pi':
      return {
        lead: 'Run this in a terminal, then /reload in a running Pi session.',
        artefacts: [{ kind: 'code', text: hostMcpSnippet('pi', ctx) }],
        after: "Not needed with Plannotator's Pi extension: it already writes here.",
      };
    case 'opencode':
      return {
        lead: "Add this to opencode.json: the project's, or ~/.config/opencode/opencode.json.",
        artefacts: [
          {
            kind: 'code',
            label: 'opencode.json',
            text: json({ $schema: 'https://opencode.ai/config.json', mcp: { [SERVER]: { type: 'local', command: [...ctx.command], enabled: true } } }),
          },
        ],
        after: "Not needed with Plannotator's OpenCode plugin: it already writes here.",
      };
    case 'zed':
      return {
        lead: "Add this to Zed's settings.json.",
        artefacts: [{ kind: 'code', label: '~/.config/zed/settings.json', text: json({ context_servers: { [SERVER]: { ...stdio(ctx), env: {} } } }) }],
        another: { summary: 'in Zed: Settings > AI > MCP Servers > Add Server' },
      };
    case 'kiro':
      return {
        lead: "Add this to Kiro's MCP config. Kiro picks it up without a restart.",
        artefacts: [{ kind: 'code', label: '~/.kiro/settings/mcp.json', text: mcpServersSnippet(ctx) }],
      };
    case 'jetbrains':
      return {
        lead: 'In the IDE: Settings | Tools | AI Assistant | Model Context Protocol (MCP) > Add, then paste this.',
        artefacts: [{ kind: 'code', text: mcpServersSnippet(ctx) }],
      };
    case 'other':
      return {
        lead: 'Use the command where your client can run one. It starts the Inbox when it is not running.',
        artefacts: [
          { kind: 'code', label: 'Command (stdio)', text: cmd },
          { kind: 'code', label: 'Address (Streamable HTTP)', text: ctx.mcpUrl },
        ],
        note: 'The port can change when the Inbox restarts, and the address fails while it is stopped. Prefer the command.',
      };
  }
}
