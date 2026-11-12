import { $ } from "bun";
import { tmpdir } from "os";
import path from "path";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";
import { getGitContext, runGitDiff } from "@plannotator/server/git";

// @ts-ignore - Bun import attribute for text
import html from "../../apps/review/dist/index.html" with { type: "text" };

const KEEP = process.argv.includes("--keep");

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
const fixture = (name: string) => Bun.file(path.join(FIXTURES_DIR, name)).text();

const sandbox = path.join(tmpdir(), `plannotator-wt-test-${Date.now()}`);
const mainRepo = path.join(sandbox, "main-repo");

console.error("=== Worktree Review Test ===");
console.error("");
console.error(`Sandbox: ${sandbox}`);
console.error("");

await $`mkdir -p ${mainRepo}`.quiet();
await $`git init`.quiet().cwd(mainRepo);
await $`git checkout -b main`.quiet().cwd(mainRepo);

const files: Record<string, string> = {
  "src/index.ts": [
    `import { App } from './app';`,
    `import { loadConfig } from './config';`,
    ``,
    `const config = loadConfig();`,
    `const app = new App(config);`,
    `app.start();`,
    ``,
  ].join("\n"),
  "src/app.ts": [
    `import type { Config } from './config';`,
    `import { Router } from './router';`,
    `import { Logger } from './utils/logger';`,
    ``,
    `export class App {`,
    `  private router: Router;`,
    `  private logger: Logger;`,
    ``,
    `  constructor(private config: Config) {`,
    `    this.logger = new Logger(config.logLevel);`,
    `    this.router = new Router();`,
    `  }`,
    ``,
    `  start() {`,
    `    this.logger.info('Starting server...');`,
    `    this.router.register('GET', '/', (req) => ({ status: 200, body: 'OK' }));`,
    `    this.router.register('GET', '/health', (req) => ({ status: 200, body: 'healthy' }));`,
    `    this.logger.info(\`Server running on port \${this.config.port}\`);`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "src/config.ts": [
    `export interface Config {`,
    `  port: number;`,
    `  logLevel: 'debug' | 'info' | 'warn' | 'error';`,
    `  dbUrl: string;`,
    `  maxConnections: number;`,
    `}`,
    ``,
    `export function loadConfig(): Config {`,
    `  return {`,
    `    port: parseInt(process.env.PORT || '3000'),`,
    `    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) || 'info',`,
    `    dbUrl: process.env.DATABASE_URL || 'postgres://localhost:5432/app',`,
    `    maxConnections: parseInt(process.env.MAX_CONNECTIONS || '10'),`,
    `  };`,
    `}`,
    ``,
  ].join("\n"),
  "src/router.ts": [
    `export interface Route {`,
    `  method: string;`,
    `  path: string;`,
    `  handler: (req: Request) => Response | { status: number; body: string };`,
    `}`,
    ``,
    `export class Router {`,
    `  private routes: Route[] = [];`,
    ``,
    `  register(method: string, path: string, handler: Route['handler']) {`,
    `    this.routes.push({ method, path, handler });`,
    `  }`,
    ``,
    `  match(method: string, path: string): Route | undefined {`,
    `    return this.routes.find(r => r.method === method && r.path === path);`,
    `  }`,
    ``,
    `  list(): Route[] {`,
    `    return [...this.routes];`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "src/utils/parser.ts": [
    `export interface ParseResult {`,
    `  lines: string[];`,
    `  lineCount: number;`,
    `  isEmpty: boolean;`,
    `}`,
    ``,
    `export function parse(input: string): ParseResult {`,
    `  const lines = input.split('\\n');`,
    `  return {`,
    `    lines,`,
    `    lineCount: lines.length,`,
    `    isEmpty: lines.every(l => l.trim() === ''),`,
    `  };`,
    `}`,
    ``,
    `export function parseJSON<T>(input: string): T | null {`,
    `  try {`,
    `    return JSON.parse(input);`,
    `  } catch {`,
    `    return null;`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "src/utils/format.ts": [
    `export function formatDate(date: Date): string {`,
    `  return date.toISOString().split('T')[0];`,
    `}`,
    ``,
    `export function formatBytes(bytes: number): string {`,
    `  if (bytes === 0) return '0 B';`,
    `  const units = ['B', 'KB', 'MB', 'GB'];`,
    `  const i = Math.floor(Math.log(bytes) / Math.log(1024));`,
    `  return \`\${(bytes / Math.pow(1024, i)).toFixed(1)} \${units[i]}\`;`,
    `}`,
    ``,
    `export function slugify(text: string): string {`,
    `  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');`,
    `}`,
    ``,
  ].join("\n"),
  "src/utils/logger.ts": [
    `const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;`,
    `type LogLevel = keyof typeof LEVELS;`,
    ``,
    `export class Logger {`,
    `  constructor(private level: LogLevel = 'info') {}`,
    ``,
    `  private log(level: LogLevel, message: string, data?: unknown) {`,
    `    if (LEVELS[level] >= LEVELS[this.level]) {`,
    `      const timestamp = new Date().toISOString();`,
    `      console.log(\`[\${timestamp}] [\${level.toUpperCase()}] \${message}\`, data ?? '');`,
    `    }`,
    `  }`,
    ``,
    `  debug(msg: string, data?: unknown) { this.log('debug', msg, data); }`,
    `  info(msg: string, data?: unknown) { this.log('info', msg, data); }`,
    `  warn(msg: string, data?: unknown) { this.log('warn', msg, data); }`,
    `  error(msg: string, data?: unknown) { this.log('error', msg, data); }`,
    `}`,
    ``,
  ].join("\n"),
  "src/db/connection.ts": [
    `import type { Config } from '../config';`,
    ``,
    `export interface DBConnection {`,
    `  query<T>(sql: string, params?: unknown[]): Promise<T[]>;`,
    `  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>;`,
    `  close(): Promise<void>;`,
    `}`,
    ``,
    `export async function createConnection(config: Config): Promise<DBConnection> {`,
    `  console.log(\`Connecting to \${config.dbUrl}...\`);`,
    `  // Simulated connection`,
    `  return {`,
    `    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {`,
    `      return [];`,
    `    },`,
    `    async execute(sql: string, params?: unknown[]) {`,
    `      return { affectedRows: 0 };`,
    `    },`,
    `    async close() {`,
    `      console.log('Connection closed');`,
    `    },`,
    `  };`,
    `}`,
    ``,
  ].join("\n"),
  "src/db/migrations.ts": [
    `import type { DBConnection } from './connection';`,
    ``,
    `interface Migration {`,
    `  version: number;`,
    `  name: string;`,
    `  up: string;`,
    `  down: string;`,
    `}`,
    ``,
    `const migrations: Migration[] = [`,
    `  {`,
    `    version: 1,`,
    `    name: 'create_users',`,
    `    up: 'CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT NOW())',`,
    `    down: 'DROP TABLE users',`,
    `  },`,
    `  {`,
    `    version: 2,`,
    `    name: 'create_posts',`,
    `    up: 'CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), title TEXT, body TEXT, created_at TIMESTAMP DEFAULT NOW())',`,
    `    down: 'DROP TABLE posts',`,
    `  },`,
    `];`,
    ``,
    `export async function runMigrations(db: DBConnection): Promise<void> {`,
    `  for (const m of migrations) {`,
    `    await db.execute(m.up);`,
    `    console.log(\`Migration \${m.version}: \${m.name}\`);`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "package.json": [
    `{`,
    `  "name": "acme-api",`,
    `  "version": "1.0.0",`,
    `  "type": "module",`,
    `  "scripts": {`,
    `    "dev": "bun run --watch src/index.ts",`,
    `    "build": "bun build src/index.ts --outdir dist",`,
    `    "test": "bun test",`,
    `    "lint": "eslint src/"`,
    `  },`,
    `  "dependencies": {`,
    `    "pg": "^8.11.0"`,
    `  },`,
    `  "devDependencies": {`,
    `    "typescript": "^5.3.0",`,
    `    "@types/pg": "^8.10.0",`,
    `    "eslint": "^8.50.0"`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
  "tsconfig.json": [
    `{`,
    `  "compilerOptions": {`,
    `    "target": "ES2022",`,
    `    "module": "ESNext",`,
    `    "moduleResolution": "bundler",`,
    `    "strict": true,`,
    `    "outDir": "dist",`,
    `    "rootDir": "src",`,
    `    "skipLibCheck": true`,
    `  },`,
    `  "include": ["src/**/*.ts"]`,
    `}`,
    ``,
  ].join("\n"),
  "README.md": [
    `# Acme API`,
    ``,
    `A REST API for the Acme platform.`,
    ``,
    `## Getting Started`,
    ``,
    `\`\`\`bash`,
    `bun install`,
    `bun run dev`,
    `\`\`\``,
    ``,
    `## Architecture`,
    ``,
    `- \`src/app.ts\` — Main application class`,
    `- \`src/router.ts\` — HTTP routing`,
    `- \`src/db/\` — Database layer (connection, migrations)`,
    `- \`src/utils/\` — Shared utilities (logging, parsing, formatting)`,
    ``,
  ].join("\n"),
  "src/services/registry.ts": await fixture("service-registry.ts"),
  "src/utils/deprecated-helper.ts": await fixture("deprecated-helper.ts"),
  "src/utils/string-utils.ts": await fixture("string-utils.ts"),
};

for (const [filePath, content] of Object.entries(files)) {
  const fullPath = path.join(mainRepo, filePath);
  await $`mkdir -p ${path.dirname(fullPath)}`.quiet();
  await Bun.write(fullPath, content);
}

await $`git add -A`.quiet().cwd(mainRepo);
await $`git commit -m "initial commit"`.quiet().cwd(mainRepo);

await Bun.write(
  path.join(mainRepo, "src/index.ts"),
  [
    `import { App } from './app';`,
    `import { loadConfig } from './config';`,
    `import { Logger } from './utils/logger';`,
    ``,
    `const config = loadConfig();`,
    `const logger = new Logger(config.logLevel);`,
    `const app = new App(config);`,
    ``,
    `logger.info('Booting application...');`,
    `app.start();`,
    `logger.info('Application started successfully');`,
    ``,
  ].join("\n"),
);
await Bun.write(
  path.join(mainRepo, "src/utils/format.ts"),
  [
    `export function formatDate(date: Date): string {`,
    `  return date.toISOString().split('T')[0];`,
    `}`,
    ``,
    `export function formatBytes(bytes: number): string {`,
    `  if (bytes < 0) throw new Error('bytes must be non-negative');`,
    `  if (bytes === 0) return '0 B';`,
    `  const units = ['B', 'KB', 'MB', 'GB', 'TB'];`,
    `  const i = Math.floor(Math.log(bytes) / Math.log(1024));`,
    `  return \`\${(bytes / Math.pow(1024, i)).toFixed(1)} \${units[i]}\`;`,
    `}`,
    ``,
    `export function slugify(text: string): string {`,
    `  return text`,
    `    .toLowerCase()`,
    `    .replace(/[^a-z0-9]+/g, '-')`,
    `    .replace(/(^-|-$)/g, '');`,
    `}`,
    ``,
    `export function truncate(text: string, maxLength: number): string {`,
    `  if (text.length <= maxLength) return text;`,
    `  return text.slice(0, maxLength - 3) + '...';`,
    `}`,
    ``,
  ].join("\n"),
);

await Bun.write(
  path.join(mainRepo, "src/services/registry.ts"),
  await fixture("service-registry-modified.ts"),
);

await $`git rm src/utils/deprecated-helper.ts`.quiet().cwd(mainRepo);

await $`git mv src/utils/string-utils.ts src/utils/text-utils.ts`.quiet().cwd(mainRepo);
await Bun.write(
  path.join(mainRepo, "src/utils/text-utils.ts"),
  await fixture("text-utils.ts"),
);

await $`mkdir -p ${path.join(mainRepo, "src/events")}`.quiet();
await Bun.write(
  path.join(mainRepo, "src/events/emitter.ts"),
  await fixture("event-emitter.ts"),
);

console.error("Created main repo with uncommitted changes:")
console.error("  - src/index.ts — small edits (2 hunks)")
console.error("  - src/utils/format.ts — modified + new function")
console.error("  - src/services/registry.ts — 4 disjoint hunks (expansion test)")
console.error("  - src/utils/deprecated-helper.ts — deleted file")
console.error("  - src/utils/string-utils.ts → text-utils.ts — renamed + additions")
console.error("  - src/events/emitter.ts — brand new file");

const wt1 = path.join(sandbox, "wt-feature-auth");
await $`git worktree add ${wt1} -b feature-auth`.quiet().cwd(mainRepo);

await Bun.write(
  path.join(wt1, "src/auth/index.ts"),
  [
    `export { authenticate, type AuthResult } from './middleware';`,
    `export { hashPassword, verifyPassword } from './passwords';`,
    `export { generateToken, verifyToken, type TokenPayload } from './tokens';`,
    `export { createUser, findUserByEmail, type User } from './users';`,
    ``,
  ].join("\n"),
);
await Bun.write(
  path.join(wt1, "src/auth/passwords.ts"),
  [
    `const SALT_ROUNDS = 12;`,
    ``,
    `export async function hashPassword(password: string): Promise<string> {`,
    `  // In production, use bcrypt or argon2`,
    `  const encoder = new TextEncoder();`,
    `  const data = encoder.encode(password + SALT_ROUNDS);`,
    `  const hash = await crypto.subtle.digest('SHA-256', data);`,
    `  return Array.from(new Uint8Array(hash))`,
    `    .map(b => b.toString(16).padStart(2, '0'))`,
    `    .join('');`,
    `}`,
    ``,
    `export async function verifyPassword(password: string, hash: string): Promise<boolean> {`,
    `  const computed = await hashPassword(password);`,
    `  return computed === hash;`,
    `}`,
    ``,
  ].join("\n"),
);
await Bun.write(
  path.join(wt1, "src/auth/tokens.ts"),
  [
    `export interface TokenPayload {`,
    `  userId: number;`,
    `  email: string;`,
    `  iat: number;`,
    `  exp: number;`,
    `}`,
    ``,
    `const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';`,
    `const TOKEN_TTL = 60 * 60 * 24; // 24 hours`,
    ``,
    `export function generateToken(userId: number, email: string): string {`,
    `  const payload: TokenPayload = {`,
    `    userId,`,
    `    email,`,
    `    iat: Math.floor(Date.now() / 1000),`,
    `    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,`,
    `  };`,
    `  // Simplified — in production use a proper JWT library`,
    `  return btoa(JSON.stringify(payload));`,
    `}`,
    ``,
    `export function verifyToken(token: string): TokenPayload | null {`,
    `  try {`,
    `    const payload = JSON.parse(atob(token)) as TokenPayload;`,
    `    if (payload.exp < Math.floor(Date.now() / 1000)) {`,
    `      return null; // Expired`,
    `    }`,
    `    return payload;`,
    `  } catch {`,
    `    return null;`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
);
await Bun.write(
  path.join(wt1, "src/auth/middleware.ts"),
  [
    `import { verifyToken, type TokenPayload } from './tokens';`,
    ``,
    `export interface AuthResult {`,
    `  authenticated: boolean;`,
    `  user?: TokenPayload;`,
    `  error?: string;`,
    `}`,
    ``,
    `export function authenticate(req: Request): AuthResult {`,
    `  const authHeader = req.headers.get('Authorization');`,
    `  if (!authHeader) {`,
    `    return { authenticated: false, error: 'Missing Authorization header' };`,
    `  }`,
    ``,
    `  const [scheme, token] = authHeader.split(' ');`,
    `  if (scheme !== 'Bearer' || !token) {`,
    `    return { authenticated: false, error: 'Invalid Authorization format. Expected: Bearer <token>' };`,
    `  }`,
    ``,
    `  const payload = verifyToken(token);`,
    `  if (!payload) {`,
    `    return { authenticated: false, error: 'Invalid or expired token' };`,
    `  }`,
    ``,
    `  return { authenticated: true, user: payload };`,
    `}`,
    ``,
  ].join("\n"),
);
await Bun.write(
  path.join(wt1, "src/auth/users.ts"),
  [
    `import type { DBConnection } from '../db/connection';`,
    `import { hashPassword } from './passwords';`,
    ``,
    `export interface User {`,
    `  id: number;`,
    `  email: string;`,
    `  passwordHash: string;`,
    `  createdAt: Date;`,
    `}`,
    ``,
    `export async function createUser(db: DBConnection, email: string, password: string): Promise<User> {`,
    `  const passwordHash = await hashPassword(password);`,
    `  const result = await db.query<User>(`,
    `    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',`,
    `    [email, passwordHash],`,
    `  );`,
    `  return result[0];`,
    `}`,
    ``,
    `export async function findUserByEmail(db: DBConnection, email: string): Promise<User | null> {`,
    `  const result = await db.query<User>(`,
    `    'SELECT * FROM users WHERE email = $1',`,
    `    [email],`,
    `  );`,
    `  return result[0] ?? null;`,
    `}`,
    ``,
  ].join("\n"),
);

await Bun.write(
  path.join(wt1, "src/app.ts"),
  [
    `import type { Config } from './config';`,
    `import { Router } from './router';`,
    `import { Logger } from './utils/logger';`,
    `import { authenticate } from './auth';`,
    `import { generateToken } from './auth/tokens';`,
    `import { findUserByEmail, createUser } from './auth/users';`,
    `import { verifyPassword } from './auth/passwords';`,
    `import { createConnection, type DBConnection } from './db/connection';`,
    ``,
    `export class App {`,
    `  private router: Router;`,
    `  private logger: Logger;`,
    `  private db!: DBConnection;`,
    ``,
    `  constructor(private config: Config) {`,
    `    this.logger = new Logger(config.logLevel);`,
    `    this.router = new Router();`,
    `  }`,
    ``,
    `  async start() {`,
    `    this.db = await createConnection(this.config);`,
    `    this.logger.info('Database connected');`,
    ``,
    `    // Public routes`,
    `    this.router.register('GET', '/', (req) => ({ status: 200, body: 'OK' }));`,
    `    this.router.register('GET', '/health', (req) => ({ status: 200, body: 'healthy' }));`,
    ``,
    `    // Auth routes`,
    `    this.router.register('POST', '/auth/register', async (req) => {`,
    `      const { email, password } = await req.json() as { email: string; password: string };`,
    `      const user = await createUser(this.db, email, password);`,
    `      const token = generateToken(user.id, user.email);`,
    `      return { status: 201, body: JSON.stringify({ token }) };`,
    `    });`,
    ``,
    `    this.router.register('POST', '/auth/login', async (req) => {`,
    `      const { email, password } = await req.json() as { email: string; password: string };`,
    `      const user = await findUserByEmail(this.db, email);`,
    `      if (!user || !(await verifyPassword(password, user.passwordHash))) {`,
    `        return { status: 401, body: JSON.stringify({ error: 'Invalid credentials' }) };`,
    `      }`,
    `      const token = generateToken(user.id, user.email);`,
    `      return { status: 200, body: JSON.stringify({ token }) };`,
    `    });`,
    ``,
    `    // Protected route example`,
    `    this.router.register('GET', '/api/me', (req) => {`,
    `      const auth = authenticate(req);`,
    `      if (!auth.authenticated) {`,
    `        return { status: 401, body: JSON.stringify({ error: auth.error }) };`,
    `      }`,
    `      return { status: 200, body: JSON.stringify({ user: auth.user }) };`,
    `    });`,
    ``,
    `    this.logger.info(\`Server running on port \${this.config.port}\`);`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
);

await Bun.write(
  path.join(wt1, "src/db/migrations.ts"),
  [
    `import type { DBConnection } from './connection';`,
    ``,
    `interface Migration {`,
    `  version: number;`,
    `  name: string;`,
    `  up: string;`,
    `  down: string;`,
    `}`,
    ``,
    `const migrations: Migration[] = [`,
    `  {`,
    `    version: 1,`,
    `    name: 'create_users',`,
    `    up: 'CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())',`,
    `    down: 'DROP TABLE users',`,
    `  },`,
    `  {`,
    `    version: 2,`,
    `    name: 'create_posts',`,
    `    up: 'CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), title TEXT, body TEXT, created_at TIMESTAMP DEFAULT NOW())',`,
    `    down: 'DROP TABLE posts',`,
    `  },`,
    `  {`,
    `    version: 3,`,
    `    name: 'create_sessions',`,
    `    up: 'CREATE TABLE sessions (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), token TEXT NOT NULL, expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT NOW())',`,
    `    down: 'DROP TABLE sessions',`,
    `  },`,
    `];`,
    ``,
    `export async function runMigrations(db: DBConnection): Promise<void> {`,
    `  for (const m of migrations) {`,
    `    await db.execute(m.up);`,
    `    console.log(\`Migration \${m.version}: \${m.name}\`);`,
    `  }`,
    `}`,
    ``,
    `export async function rollbackMigration(db: DBConnection, version: number): Promise<void> {`,
    `  const migration = migrations.find(m => m.version === version);`,
    `  if (!migration) throw new Error(\`Migration \${version} not found\`);`,
    `  await db.execute(migration.down);`,
    `  console.log(\`Rolled back migration \${version}: \${migration.name}\`);`,
    `}`,
    ``,
  ].join("\n"),
);

await $`git add -A`.quiet().cwd(wt1);
await $`git commit -m "feat: add authentication module"`.quiet().cwd(wt1);

await Bun.write(
  path.join(wt1, "src/auth/rate-limit.ts"),
  [
    `const WINDOW_MS = 60 * 1000;`,
    `const MAX_ATTEMPTS = 5;`,
    ``,
    `const attempts = new Map<string, { count: number; resetAt: number }>();`,
    ``,
    `export function checkRateLimit(key: string): boolean {`,
    `  const now = Date.now();`,
    `  const entry = attempts.get(key);`,
    `  if (!entry || now > entry.resetAt) {`,
    `    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });`,
    `    return true;`,
    `  }`,
    `  entry.count++;`,
    `  return entry.count <= MAX_ATTEMPTS;`,
    `}`,
    ``,
  ].join("\n"),
);

console.error("Created worktree: feature-auth (committed + 1 uncommitted file)");

const wt2 = path.join(sandbox, "wt-fix-parser");
await $`git worktree add ${wt2} -b fix-parser`.quiet().cwd(mainRepo);

await Bun.write(
  path.join(wt2, "src/utils/parser.ts"),
  [
    `export interface ParseResult {`,
    `  lines: string[];`,
    `  lineCount: number;`,
    `  isEmpty: boolean;`,
    `}`,
    ``,
    `export function parse(input: string): ParseResult {`,
    `  if (!input || input.trim() === '') {`,
    `    return { lines: [], lineCount: 0, isEmpty: true };`,
    `  }`,
    `  const lines = input.split('\\n').filter(line => line.length > 0);`,
    `  return {`,
    `    lines,`,
    `    lineCount: lines.length,`,
    `    isEmpty: lines.length === 0,`,
    `  };`,
    `}`,
    ``,
    `export function parseJSON<T>(input: string): T | null {`,
    `  try {`,
    `    return JSON.parse(input);`,
    `  } catch {`,
    `    return null;`,
    `  }`,
    `}`,
    ``,
    `export function parseCSV(input: string): string[][] {`,
    `  const { lines } = parse(input);`,
    `  return lines.map(line => {`,
    `    const fields: string[] = [];`,
    `    let current = '';`,
    `    let inQuotes = false;`,
    `    for (const char of line) {`,
    `      if (char === '"') {`,
    `        inQuotes = !inQuotes;`,
    `      } else if (char === ',' && !inQuotes) {`,
    `        fields.push(current.trim());`,
    `        current = '';`,
    `      } else {`,
    `        current += char;`,
    `      }`,
    `    }`,
    `    fields.push(current.trim());`,
    `    return fields;`,
    `  });`,
    `}`,
    ``,
    `export function parseURL(url: string): { host: string; path: string; params: Record<string, string> } | null {`,
    `  try {`,
    `    const parsed = new URL(url);`,
    `    const params: Record<string, string> = {};`,
    `    parsed.searchParams.forEach((v, k) => { params[k] = v; });`,
    `    return { host: parsed.host, path: parsed.pathname, params };`,
    `  } catch {`,
    `    return null;`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
);

await Bun.write(
  path.join(wt2, "src/utils/logger.ts"),
  [
    `const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;`,
    `type LogLevel = keyof typeof LEVELS;`,
    ``,
    `interface LogEntry {`,
    `  timestamp: string;`,
    `  level: LogLevel;`,
    `  message: string;`,
    `  data?: unknown;`,
    `  context?: string;`,
    `}`,
    ``,
    `export class Logger {`,
    `  private context?: string;`,
    ``,
    `  constructor(private level: LogLevel = 'info', context?: string) {`,
    `    this.context = context;`,
    `  }`,
    ``,
    `  child(context: string): Logger {`,
    `    return new Logger(this.level, this.context ? \`\${this.context}.\${context}\` : context);`,
    `  }`,
    ``,
    `  private log(level: LogLevel, message: string, data?: unknown) {`,
    `    if (LEVELS[level] < LEVELS[this.level]) return;`,
    ``,
    `    const entry: LogEntry = {`,
    `      timestamp: new Date().toISOString(),`,
    `      level,`,
    `      message,`,
    `      ...(data !== undefined && { data }),`,
    `      ...(this.context && { context: this.context }),`,
    `    };`,
    ``,
    `    if (level === 'error') {`,
    `      console.error(JSON.stringify(entry));`,
    `    } else {`,
    `      console.log(JSON.stringify(entry));`,
    `    }`,
    `  }`,
    ``,
    `  debug(msg: string, data?: unknown) { this.log('debug', msg, data); }`,
    `  info(msg: string, data?: unknown) { this.log('info', msg, data); }`,
    `  warn(msg: string, data?: unknown) { this.log('warn', msg, data); }`,
    `  error(msg: string, data?: unknown) { this.log('error', msg, data); }`,
    `}`,
    ``,
  ].join("\n"),
);

await Bun.write(
  path.join(wt2, "src/utils/validator.ts"),
  [
    `export interface ValidationResult {`,
    `  valid: boolean;`,
    `  errors: string[];`,
    `}`,
    ``,
    `export function validateEmail(email: string): ValidationResult {`,
    `  const errors: string[] = [];`,
    `  if (!email) errors.push('Email is required');`,
    `  if (!email.includes('@')) errors.push('Email must contain @');`,
    `  if (email.length > 254) errors.push('Email too long');`,
    `  return { valid: errors.length === 0, errors };`,
    `}`,
    ``,
    `export function validatePassword(password: string): ValidationResult {`,
    `  const errors: string[] = [];`,
    `  if (password.length < 8) errors.push('Password must be at least 8 characters');`,
    `  if (!/[A-Z]/.test(password)) errors.push('Password must contain an uppercase letter');`,
    `  if (!/[0-9]/.test(password)) errors.push('Password must contain a number');`,
    `  return { valid: errors.length === 0, errors };`,
    `}`,
    ``,
    `export function validatePort(port: number): ValidationResult {`,
    `  const errors: string[] = [];`,
    `  if (!Number.isInteger(port)) errors.push('Port must be an integer');`,
    `  if (port < 1 || port > 65535) errors.push('Port must be between 1 and 65535');`,
    `  return { valid: errors.length === 0, errors };`,
    `}`,
    ``,
  ].join("\n"),
);

await Bun.write(
  path.join(wt2, "src/utils/retry.ts"),
  [
    `interface RetryOptions {`,
    `  maxAttempts: number;`,
    `  delayMs: number;`,
    `  backoff: 'linear' | 'exponential';`,
    `}`,
    ``,
    `const defaults: RetryOptions = {`,
    `  maxAttempts: 3,`,
    `  delayMs: 1000,`,
    `  backoff: 'exponential',`,
    `};`,
    ``,
    `export async function retry<T>(`,
    `  fn: () => Promise<T>,`,
    `  options: Partial<RetryOptions> = {},`,
    `): Promise<T> {`,
    `  const opts = { ...defaults, ...options };`,
    `  let lastError: Error | undefined;`,
    ``,
    `  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {`,
    `    try {`,
    `      return await fn();`,
    `    } catch (err) {`,
    `      lastError = err instanceof Error ? err : new Error(String(err));`,
    `      if (attempt < opts.maxAttempts) {`,
    `        const delay = opts.backoff === 'exponential'`,
    `          ? opts.delayMs * Math.pow(2, attempt - 1)`,
    `          : opts.delayMs * attempt;`,
    `        await new Promise(resolve => setTimeout(resolve, delay));`,
    `      }`,
    `    }`,
    `  }`,
    ``,
    `  throw lastError;`,
    `}`,
    ``,
  ].join("\n"),
);

await $`git add src/utils/parser.ts src/utils/logger.ts`.quiet().cwd(wt2);
await $`git commit -m "fix: handle empty input and add CSV/URL parsing"`.quiet().cwd(wt2);

console.error("Created worktree: fix-parser (2 committed + 2 untracked files)");

const wt3 = path.join(sandbox, "wt-empty");
await $`git worktree add ${wt3} -b empty-branch`.quiet().cwd(mainRepo);

console.error("Created worktree: empty-branch (no changes — tests empty state)");

const wt4 = path.join(sandbox, "wt-detached");
const headSha = (await $`git rev-parse HEAD`.quiet().cwd(mainRepo)).text().trim();
await $`git worktree add --detach ${wt4} ${headSha}`.quiet().cwd(mainRepo);

await Bun.write(
  path.join(wt4, "src/router.ts"),
  [
    `export interface Route {`,
    `  method: string;`,
    `  path: string;`,
    `  handler: (req: Request) => Response | { status: number; body: string } | Promise<Response | { status: number; body: string }>;`,
    `}`,
    ``,
    `export class Router {`,
    `  private routes: Route[] = [];`,
    `  private middleware: ((req: Request) => void)[] = [];`,
    ``,
    `  use(fn: (req: Request) => void) {`,
    `    this.middleware.push(fn);`,
    `  }`,
    ``,
    `  register(method: string, path: string, handler: Route['handler']) {`,
    `    this.routes.push({ method, path, handler });`,
    `  }`,
    ``,
    `  match(method: string, path: string): Route | undefined {`,
    `    return this.routes.find(r => r.method === method && r.path === path);`,
    `  }`,
    ``,
    `  async handle(req: Request): Promise<{ status: number; body: string }> {`,
    `    const url = new URL(req.url);`,
    ``,
    `    // Run middleware`,
    `    for (const fn of this.middleware) {`,
    `      fn(req);`,
    `    }`,
    ``,
    `    const route = this.match(req.method, url.pathname);`,
    `    if (!route) {`,
    `      return { status: 404, body: JSON.stringify({ error: 'Not Found', path: url.pathname }) };`,
    `    }`,
    ``,
    `    try {`,
    `      const result = await route.handler(req);`,
    `      if (result instanceof Response) {`,
    `        return { status: result.status, body: await result.text() };`,
    `      }`,
    `      return result;`,
    `    } catch (err) {`,
    `      const message = err instanceof Error ? err.message : 'Internal Server Error';`,
    `      return { status: 500, body: JSON.stringify({ error: message }) };`,
    `    }`,
    `  }`,
    ``,
    `  list(): Route[] {`,
    `    return [...this.routes];`,
    `  }`,
    `}`,
    ``,
  ].join("\n"),
);

await Bun.write(
  path.join(wt4, "src/db/connection.ts"),
  [
    `import type { Config } from '../config';`,
    ``,
    `export interface DBConnection {`,
    `  query<T>(sql: string, params?: unknown[]): Promise<T[]>;`,
    `  execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }>;`,
    `  close(): Promise<void>;`,
    `  isConnected(): boolean;`,
    `}`,
    ``,
    `const MAX_RETRIES = 3;`,
    `const RETRY_DELAY = 1000;`,
    ``,
    `export async function createConnection(config: Config): Promise<DBConnection> {`,
    `  let connected = false;`,
    `  let retries = 0;`,
    ``,
    `  while (!connected && retries < MAX_RETRIES) {`,
    `    try {`,
    `      console.log(\`Connecting to \${config.dbUrl} (attempt \${retries + 1}/\${MAX_RETRIES})...\`);`,
    `      // Simulated connection attempt`,
    `      connected = true;`,
    `    } catch (err) {`,
    `      retries++;`,
    `      if (retries < MAX_RETRIES) {`,
    `        console.warn(\`Connection failed, retrying in \${RETRY_DELAY}ms...\`);`,
    `        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));`,
    `      } else {`,
    `        throw new Error(\`Failed to connect after \${MAX_RETRIES} attempts: \${err}\`);`,
    `      }`,
    `    }`,
    `  }`,
    ``,
    `  return {`,
    `    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {`,
    `      if (!connected) throw new Error('Not connected');`,
    `      return [];`,
    `    },`,
    `    async execute(sql: string, params?: unknown[]) {`,
    `      if (!connected) throw new Error('Not connected');`,
    `      return { affectedRows: 0 };`,
    `    },`,
    `    async close() {`,
    `      connected = false;`,
    `      console.log('Connection closed');`,
    `    },`,
    `    isConnected() {`,
    `      return connected;`,
    `    },`,
    `  };`,
    `}`,
    ``,
  ].join("\n"),
);

await $`git add -A`.quiet().cwd(wt4);
await $`git commit -m "hotfix: add 404 handling and connection retry logic"`.quiet().cwd(wt4);

console.error("Created worktree: detached HEAD (2 committed files — hotfix)");
console.error("");

process.chdir(mainRepo);

const gitContext = await getGitContext();
const { patch: rawPatch, label: gitRef, error: diffError } = await runGitDiff(
  "uncommitted",
  gitContext.defaultBranch
);

console.error("Git context discovered:");
console.error(`  Current branch: ${gitContext.currentBranch}`);
console.error(`  Default branch: ${gitContext.defaultBranch}`);
console.error(`  Diff options: ${gitContext.diffOptions.map(o => o.label).join(', ')}`);
if (gitContext.worktrees.length > 0) {
  console.error(`  Worktrees:`);
  for (const wt of gitContext.worktrees) {
    console.error(`    ${wt.branch || wt.path.split('/').pop()} (${wt.path})`);
  }
}
console.error("");

console.error("Starting review server...");
console.error("Browser should open automatically.");
console.error("");
console.error("=== WORKTREE TESTS ===");
console.error("  1. 'Context' dropdown appears above 'View' dropdown listing worktrees");
console.error("  2. Select 'feature-auth' in Context → highlighted pill, files update");
console.error("  3. 'Uncommitted' in View shows rate-limit.ts");
console.error("  4. 'Last commit' in View shows committed auth module (5 files)");
console.error("  5. Switch Context back to main branch → restores main repo files");
console.error("  6. Switch directly between worktrees without returning to main");
console.error("  7. 'empty-branch' context → all View options show empty state");
console.error("  8. Detached HEAD worktree uses directory name as label");
console.error("");
console.error("=== EXPANDABLE DIFF CONTEXT TESTS ===");
console.error("  8.  registry.ts — 4 disjoint hunks. Between each pair, you should see");
console.error("      'N unmodified lines' separators with expand up/down/both buttons.");
console.error("  9.  Click expand up/down — reveals lines incrementally.");
console.error("      Small gaps show a single 'expand all' button instead.");
console.error("  10. Top-of-file (above first hunk) and bottom-of-file (below last hunk)");
console.error("      should also be expandable.");
console.error("  11. deprecated-helper.ts — DELETED file. Only old content for expansion.");
console.error("  12. string-utils.ts → text-utils.ts — RENAMED. Old path used for old side.");
console.error("  13. events/emitter.ts — NEW file. Only new content, expansion above hunk.");
console.error("  14. Switch diff types (uncommitted → last-commit → vs main) — expansion works in all.");
console.error("  15. Toggle split/unified — expansion separators appear in both views.");
console.error("");

const server = await startReviewServer({
  rawPatch,
  gitRef,
  error: diffError,
  origin: "claude-code",
  diffType: "uncommitted",
  gitContext,
  sharingEnabled: false,
  htmlContent: html as unknown as string,
  onReady: (url, isRemote, port) => handleReviewServerReady(url, isRemote, port),
});

const result = await server.waitForDecision();
await Bun.sleep(1500);
server.stop();

console.error("");
console.error("Feedback received:");
console.log(JSON.stringify(result, null, 2));

if (!KEEP) {
  console.error("");
  console.error("Cleaning up sandbox...");
  await $`git worktree remove ${wt1} --force`.quiet().cwd(mainRepo).nothrow();
  await $`git worktree remove ${wt2} --force`.quiet().cwd(mainRepo).nothrow();
  await $`git worktree remove ${wt3} --force`.quiet().cwd(mainRepo).nothrow();
  await $`git worktree remove ${wt4} --force`.quiet().cwd(mainRepo).nothrow();
  await $`rm -rf ${sandbox}`.quiet();
  console.error("Done.");
} else {
  console.error("");
  console.error(`Sandbox kept at: ${sandbox}`);
  console.error("To clean up manually:");
  console.error(`  rm -rf ${sandbox}`);
}

process.exit(0);
