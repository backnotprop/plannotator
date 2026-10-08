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

/** What a selected tab shows: the artefact, one short note, and the folded "Another way". */
export interface HarnessPanel {
  artefacts: Artefact[];
  note?: string;
  another?: { summary: string; body?: Artefact };
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

/** What "Use MCP instead" reveals under each Plannotator host's card. */
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
        artefacts: [{ kind: 'code', text: hostMcpSnippet('claude-code', ctx) }],
        note: "Not needed with Plannotator's Claude Code plugin, whose mod already writes here.",
        another: {
          summary: 'the HTTP address',
          body: { kind: 'code', text: `claude mcp add --scope user --transport http ${SERVER} ${ctx.mcpUrl}` },
        },
      };
    case 'claude-app':
      return {
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
        note: 'Merge it into mcpServers in Claude > Settings > Developer > Edit Config, then quit and reopen Claude. claude.ai connectors cannot reach this computer.',
      };
    case 'codex':
      return {
        artefacts: [{ kind: 'code', text: `codex mcp add ${SERVER} -- ${cmd}` }],
        note: 'Also adds it to the Codex app and the IDE extension. Restart them after.',
        another: { summary: 'in the Codex app: Settings > MCP servers > Add server > STDIO then Restart' },
      };
    case 'cursor':
      return {
        artefacts: [{ kind: 'link', label: 'Add to Cursor', href: cursorInstallLink(ctx) }],
        note: 'Opens Cursor, which asks before it adds the server.',
        another: { summary: 'add it to ~/.cursor/mcp.json by hand', body: { kind: 'code', label: '~/.cursor/mcp.json', text: mcpServersSnippet(ctx) } },
      };
    case 'vscode':
      return {
        artefacts: [{ kind: 'link', label: 'Install in VS Code', href: vscodeInstallLink(ctx) }],
        note: 'Opens VS Code, which asks you to trust the server the first time it starts.',
        another: {
          summary: 'run code --add-mcp in a terminal',
          body: { kind: 'code', text: `code --add-mcp ${shellWord(JSON.stringify({ name: SERVER, type: 'stdio', ...stdio(ctx) }))}` },
        },
      };
    case 'windsurf':
      return {
        artefacts: [{ kind: 'code', text: `devin mcp add -s user ${SERVER} -- ${cmd}` }],
        note: 'Adds it to Devin Desktop (formerly Windsurf) in every project.',
        another: {
          summary: 'add it to ~/.config/devin/mcp_config.json by hand',
          body: { kind: 'code', label: '~/.config/devin/mcp_config.json', text: mcpServersSnippet(ctx) },
        },
      };
    case 'gemini':
      return {
        artefacts: [{ kind: 'code', text: `gemini mcp add -s user ${SERVER} ${cmd}` }],
        note: 'Adds it to Gemini CLI in every project.',
      };
    case 'goose':
      return {
        artefacts: [{ kind: 'link', label: 'Add to Goose', href: gooseInstallLink(ctx) }],
        note: 'Opens Goose to add the extension.',
        another: {
          summary: 'in Goose: Extensions > Add custom extension > Standard IO with this command',
          body: { kind: 'code', text: cmd },
        },
      };
    case 'amp':
      return {
        artefacts: [{ kind: 'code', text: `amp mcp add ${SERVER} -- ${cmd}` }],
        note: 'Run it in a terminal.',
      };
    case 'cline':
      return {
        artefacts: [{ kind: 'code', text: `cline mcp add ${SERVER} --yes -- ${cmd}` }],
        note: 'Adds it to the Cline CLI.',
        another: {
          summary: 'in the Cline extension: MCP Servers > Configure > Configure MCP Servers then paste this',
          body: { kind: 'code', text: mcpServersSnippet(ctx) },
        },
      };
    case 'pi':
      return {
        artefacts: [{ kind: 'code', text: hostMcpSnippet('pi', ctx) }],
        note: 'Then run /reload in a running Pi session.',
      };
    case 'opencode':
      return {
        artefacts: [
          {
            kind: 'code',
            label: 'opencode.json',
            text: json({ $schema: 'https://opencode.ai/config.json', mcp: { [SERVER]: { type: 'local', command: [...ctx.command], enabled: true } } }),
          },
        ],
        note: "Use the project's opencode.json or ~/.config/opencode/opencode.json.",
      };
    case 'zed':
      return {
        artefacts: [{ kind: 'code', label: '~/.config/zed/settings.json', text: json({ context_servers: { [SERVER]: { ...stdio(ctx), env: {} } } }) }],
        note: "Merge it into Zed's settings.json.",
        another: { summary: 'in Zed: Settings > AI > MCP Servers > Add Server' },
      };
    case 'kiro':
      return {
        artefacts: [{ kind: 'code', label: '~/.kiro/settings/mcp.json', text: mcpServersSnippet(ctx) }],
        note: 'Kiro picks it up without a restart.',
      };
    case 'jetbrains':
      return {
        artefacts: [{ kind: 'code', text: mcpServersSnippet(ctx) }],
        note: 'Paste it in Settings | Tools | AI Assistant | Model Context Protocol (MCP) > Add.',
      };
    case 'other':
      return {
        artefacts: [
          { kind: 'code', label: 'Command (stdio)', text: cmd },
          { kind: 'code', label: 'Address (Streamable HTTP)', text: ctx.mcpUrl },
        ],
        note: 'Prefer the command: the port can change when the Inbox restarts.',
      };
  }
}
