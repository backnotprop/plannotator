/**
 * Plannotator Ephemeral Server
 *
 * Spawned by ExitPlanMode hook to serve Plannotator UI and handle approve/deny decisions.
 * Supports both local and SSH remote sessions.
 *
 * Environment variables:
 *   PLANNOTATOR_PORT - Fixed port to use (default: random locally, 19432 over SSH)
 *
 * Reads hook event from stdin, extracts plan content, serves UI, returns decision.
 */

import { $ } from "bun";
import { join } from "path";
import { mkdirSync, existsSync, statSync } from "fs";
import { detectProjectName } from "./project";

// --- Obsidian Integration ---

interface ObsidianConfig {
  vaultPath: string;
  folder: string;
  plan: string;
}

// --- Bear Integration ---

interface BearConfig {
  plan: string;
}

/**
 * Extract tags from markdown content using simple heuristics
 * Includes project name detection (git repo or directory name)
 */
async function extractTags(markdown: string): Promise<string[]> {
  const tags = new Set<string>(["plannotator"]);

  // Add project name tag (git repo name or directory fallback)
  const projectName = await detectProjectName();
  if (projectName) {
    tags.add(projectName);
  }

  const stopWords = new Set([
    "the", "and", "for", "with", "this", "that", "from", "into",
    "plan", "implementation", "overview", "phase", "step", "steps",
  ]);

  // Extract from first H1 title
  const h1Match = markdown.match(/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im);
  if (h1Match) {
    const titleWords = h1Match[1]
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word));
    titleWords.slice(0, 3).forEach((word) => tags.add(word));
  }

  // Extract code fence languages
  const langMatches = markdown.matchAll(/```(\w+)/g);
  const seenLangs = new Set<string>();
  for (const [, lang] of langMatches) {
    const normalizedLang = lang.toLowerCase();
    if (
      !seenLangs.has(normalizedLang) &&
      !["json", "yaml", "yml", "text", "txt", "markdown", "md"].includes(normalizedLang)
    ) {
      seenLangs.add(normalizedLang);
      tags.add(normalizedLang);
    }
  }

  return Array.from(tags).slice(0, 7);
}

/**
 * Generate frontmatter for the note
 */
function generateFrontmatter(tags: string[]): string {
  const now = new Date().toISOString();
  const tagList = tags.map((t) => t.toLowerCase()).join(", ");
  return `---
created: ${now}
source: plannotator
tags: [${tagList}]
---`;
}

/**
 * Extract title from markdown (first H1 heading)
 */
function extractTitle(markdown: string): string {
  const h1Match = markdown.match(/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im);
  if (h1Match) {
    // Clean up the title for use as filename
    return h1Match[1]
      .trim()
      .replace(/[<>:"/\\|?*]/g, '') // Remove invalid filename chars
      .replace(/\s+/g, ' ')          // Normalize whitespace
      .slice(0, 50);                 // Limit length
  }
  return 'Plan';
}

/**
 * Generate human-readable filename: Title - Mon D, YYYY H-MMam.md
 * Example: User Authentication - Jan 2, 2026 2-30pm.md
 */
function generateFilename(markdown: string): string {
  const title = extractTitle(markdown);
  const now = new Date();

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[now.getMonth()];
  const day = now.getDate();
  const year = now.getFullYear();

  let hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;

  return `${title} - ${month} ${day}, ${year} ${hours}-${minutes}${ampm}.md`;
}

/**
 * Detect Obsidian vaults by reading Obsidian's config file
 * Returns array of vault paths found on the system
 */
function detectObsidianVaults(): string[] {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    let configPath: string;

    // Platform-specific config locations
    if (process.platform === "darwin") {
      configPath = join(home, "Library/Application Support/obsidian/obsidian.json");
    } else if (process.platform === "win32") {
      const appData = process.env.APPDATA || join(home, "AppData/Roaming");
      configPath = join(appData, "obsidian/obsidian.json");
    } else {
      // Linux
      configPath = join(home, ".config/obsidian/obsidian.json");
    }

    if (!existsSync(configPath)) {
      return [];
    }

    const configContent = require("fs").readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent);

    if (!config.vaults || typeof config.vaults !== "object") {
      return [];
    }

    // Extract vault paths, filter to ones that exist
    const vaults: string[] = [];
    for (const vaultId of Object.keys(config.vaults)) {
      const vault = config.vaults[vaultId];
      if (vault.path && existsSync(vault.path)) {
        vaults.push(vault.path);
      }
    }

    return vaults;
  } catch {
    return [];
  }
}

/**
 * Save plan to Obsidian vault with cross-platform path handling
 * Returns { success: boolean, error?: string, path?: string }
 */
async function saveToObsidian(
  config: ObsidianConfig
): Promise<{ success: boolean; error?: string; path?: string }> {
  try {
    const { vaultPath, folder, plan } = config;

    // Normalize path (handle ~ on Unix, forward/back slashes)
    let normalizedVault = vaultPath.trim();

    // Expand ~ to home directory (Unix/macOS)
    if (normalizedVault.startsWith("~")) {
      const home = process.env.HOME || process.env.USERPROFILE || "";
      normalizedVault = join(home, normalizedVault.slice(1));
    }

    // Validate vault path exists and is a directory
    if (!existsSync(normalizedVault)) {
      return { success: false, error: `Vault path does not exist: ${normalizedVault}` };
    }

    const vaultStat = statSync(normalizedVault);
    if (!vaultStat.isDirectory()) {
      return { success: false, error: `Vault path is not a directory: ${normalizedVault}` };
    }

    // Build target folder path
    const folderName = folder.trim() || "plannotator";
    const targetFolder = join(normalizedVault, folderName);

    // Create folder if it doesn't exist
    mkdirSync(targetFolder, { recursive: true });

    // Generate filename and full path
    const filename = generateFilename(plan);
    const filePath = join(targetFolder, filename);

    // Generate content with frontmatter and backlink
    const tags = await extractTags(plan);
    const frontmatter = generateFrontmatter(tags);
    const content = `${frontmatter}\n\n[[Plannotator Plans]]\n\n${plan}`;

    // Write file
    await Bun.write(filePath, content);

    return { success: true, path: filePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }
}

/**
 * Save plan to Bear using x-callback-url
 * Returns { success: boolean, error?: string }
 */
async function saveToBear(
  config: BearConfig
): Promise<{ success: boolean; error?: string }> {
  try {
    const { plan } = config;

    // Extract title and tags
    const title = extractTitle(plan);
    const tags = await extractTags(plan);
    const hashtags = tags.map(t => `#${t}`).join(' ');

    // Append hashtags to content
    const content = `${plan}\n\n${hashtags}`;

    // Build Bear URL
    const url = `bear://x-callback-url/create?title=${encodeURIComponent(title)}&text=${encodeURIComponent(content)}&open_note=no`;

    // Open Bear via URL scheme
    await $`open ${url}`.quiet();

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }
}

// Embed the built HTML at compile time
import indexHtml from "../dist/index.html" with { type: "text" };

// --- SSH Detection and Port Configuration ---

const DEFAULT_SSH_PORT = 19432;

function isSSHSession(): boolean {
  // SSH_TTY is set when SSH allocates a pseudo-terminal
  // SSH_CONNECTION contains "client_ip client_port server_ip server_port"
  return !!(process.env.SSH_TTY || process.env.SSH_CONNECTION);
}

function getServerPort(): number {
  // Explicit port from environment takes precedence
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
    console.error(`Warning: Invalid PLANNOTATOR_PORT "${envPort}", using default`);
  }

  // Over SSH, use fixed port for port forwarding; locally use random
  return isSSHSession() ? DEFAULT_SSH_PORT : 0;
}

const isRemote = isSSHSession();
const configuredPort = getServerPort();

// Read hook event from stdin
const eventJson = await Bun.stdin.text();

let planContent = "";
try {
  const event = JSON.parse(eventJson);
  planContent = event.tool_input?.plan || "";
} catch {
  console.error("Failed to parse hook event from stdin");
  process.exit(1);
}

if (!planContent) {
  console.error("No plan content in hook event");
  process.exit(1);
}

// Promise that resolves when user makes a decision
let resolveDecision: (result: { approved: boolean; feedback?: string }) => void;
const decisionPromise = new Promise<{ approved: boolean; feedback?: string }>(
  (resolve) => { resolveDecision = resolve; }
);

// --- Server with port conflict handling ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

async function startServer(): Promise<ReturnType<typeof Bun.serve>> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return Bun.serve({
        port: configuredPort,

        async fetch(req) {
          const url = new URL(req.url);

          // API: Get plan content
          if (url.pathname === "/api/plan") {
            const origin = process.env.PLANNOTATOR_ORIGIN || "claude-code";
            return Response.json({ plan: planContent, origin });
          }

          // API: Serve images (local paths or temp uploads)
          if (url.pathname === "/api/image") {
            const imagePath = url.searchParams.get("path");
            if (!imagePath) {
              return new Response("Missing path parameter", { status: 400 });
            }
            try {
              const file = Bun.file(imagePath);
              if (!await file.exists()) {
                return new Response("File not found", { status: 404 });
              }
              return new Response(file);
            } catch {
              return new Response("Failed to read file", { status: 500 });
            }
          }

          // API: Upload image → save to temp → return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            try {
              const formData = await req.formData();
              const file = formData.get("file") as File;
              if (!file) {
                return new Response("No file provided", { status: 400 });
              }

              const ext = file.name.split('.').pop() || 'png';
              const tempDir = "/tmp/plannotator";
              mkdirSync(tempDir, { recursive: true });
              const tempPath = `${tempDir}/${crypto.randomUUID()}.${ext}`;

              await Bun.write(tempPath, file);
              return Response.json({ path: tempPath });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Upload failed";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Detect Obsidian vaults
          if (url.pathname === "/api/obsidian/vaults") {
            const vaults = detectObsidianVaults();
            return Response.json({ vaults });
          }

          // API: Approve plan
          if (url.pathname === "/api/approve" && req.method === "POST") {
            // Check for note integrations
            try {
              const body = (await req.json().catch(() => ({}))) as {
                obsidian?: ObsidianConfig;
                bear?: BearConfig;
              };

              // Obsidian integration
              if (body.obsidian?.vaultPath && body.obsidian?.plan) {
                const result = await saveToObsidian(body.obsidian);
                if (result.success) {
                  console.error(`[Obsidian] Saved plan to: ${result.path}`);
                } else {
                  console.error(`[Obsidian] Save failed: ${result.error}`);
                }
              }

              // Bear integration
              if (body.bear?.plan) {
                const result = await saveToBear(body.bear);
                if (result.success) {
                  console.error(`[Bear] Saved plan to Bear`);
                } else {
                  console.error(`[Bear] Save failed: ${result.error}`);
                }
              }
            } catch (err) {
              // Don't block approval on integration errors
              console.error(`[Integration] Error:`, err);
            }

            resolveDecision({ approved: true });
            return Response.json({ ok: true });
          }

          // API: Deny with feedback
          if (url.pathname === "/api/deny" && req.method === "POST") {
            try {
              const body = await req.json() as { feedback?: string };
              resolveDecision({ approved: false, feedback: body.feedback || "Plan rejected by user" });
            } catch {
              resolveDecision({ approved: false, feedback: "Plan rejected by user" });
            }
            return Response.json({ ok: true });
          }

          // Serve embedded HTML for all other routes (SPA)
          return new Response(indexHtml, {
            headers: { "Content-Type": "text/html" }
          });
        },
      });
    } catch (err: unknown) {
      const isAddressInUse = err instanceof Error && err.message.includes("EADDRINUSE");
      if (isAddressInUse && attempt < MAX_RETRIES) {
        console.error(`Port ${configuredPort} in use, retrying in ${RETRY_DELAY_MS}ms... (${attempt}/${MAX_RETRIES})`);
        await Bun.sleep(RETRY_DELAY_MS);
        continue;
      }
      if (isAddressInUse) {
        console.error(`\nError: Port ${configuredPort} is already in use after ${MAX_RETRIES} retries.`);
        if (isRemote) {
          console.error(`Another Plannotator session may be running.`);
          console.error(`To use a different port, set PLANNOTATOR_PORT environment variable.\n`);
        }
        process.exit(1);
      }
      throw err;
    }
  }
  throw new Error("Unreachable");
}

const server = await startServer();

// --- Conditional browser opening and messaging ---

const serverUrl = `http://localhost:${server.port}`;
console.error(`\nPlannotator server running on ${serverUrl}`);

if (isRemote) {
  // SSH session: print helpful setup instructions
  console.error(`\n[SSH Remote Session Detected]`);
  console.error(`Add this to your local ~/.ssh/config to access Plannotator:\n`);
  console.error(`  Host your-server-alias`);
  console.error(`    LocalForward ${server.port} localhost:${server.port}\n`);
  console.error(`Then open ${serverUrl} in your local browser.\n`);
} else {
  // Local session: try to open browser (cross-platform)
  try {
    const platform = process.platform;
    if (platform === "win32") {
      await $`cmd /c start ${serverUrl}`.quiet();
    } else if (platform === "darwin") {
      await $`open ${serverUrl}`.quiet();
    } else {
      await $`xdg-open ${serverUrl}`.quiet();
    }
  } catch {
    console.error(`Open browser manually: ${serverUrl}`);
  }
}

// Wait for user decision (blocks until approve/deny)
const result = await decisionPromise;

// Give browser time to receive response and update UI
await Bun.sleep(1500);

// Cleanup
server.stop();

// Output JSON for PermissionRequest hook decision control
if (result.approved) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow"
      }
    }
  }));
} else {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: result.feedback || "Plan changes requested"
      }
    }
  }));
}

process.exit(0);
