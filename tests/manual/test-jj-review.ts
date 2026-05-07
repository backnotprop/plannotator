/**
 * Manual sandbox for JJ-backed code review.
 *
 * This creates a realistic local setup:
 *   - a bare Git repository that behaves like a tiny GitHub remote
 *   - a colocated JJ/Git working repo cloned from that remote
 *   - one committed JJ change after trunk
 *   - one current working-copy change on top
 *
 * Usage:
 *   bun run tests/manual/test-jj-review.ts [--keep] [--setup-only]
 *
 * What to test in the review UI:
 *   1. The View dropdown lists JJ modes only:
 *      Current change, Last change, Line of work, All files.
 *   2. Initial view is Current change, even if a saved Git default exists.
 *   3. Current change shows only the working-copy commit (@).
 *   4. Last change shows only the previous committed JJ change (@-).
 *   5. Line of work shows the stack from trunk() to @.
 *   6. All files shows the whole repository from root() to @.
 *   7. Hide whitespace re-runs JJ diff with -w.
 *   8. Staging controls are unavailable because JJ has no Git-style staging.
 */

import { $ } from "bun";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startReviewServer,
  handleReviewServerReady,
} from "../../packages/server/review";
import {
  getVcsContext,
  resolveInitialDiffType,
  runVcsDiff,
} from "../../packages/server/vcs";

// @ts-ignore - Bun import attribute for text
import html from "../../apps/review/dist/index.html" with { type: "text" };

const SETUP_ONLY = process.argv.includes("--setup-only");
const KEEP = process.argv.includes("--keep") || SETUP_ONLY;

const sandbox = path.join(tmpdir(), `plannotator-jj-test-${Date.now()}`);
const seedRepo = path.join(sandbox, "seed-git-repo");
const originRepo = path.join(sandbox, "origin.git");
const jjRepo = path.join(sandbox, "jj-workspace");

function lines(values: string[]): string {
  return `${values.join("\n")}\n`;
}

async function write(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(jjRepo, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await Bun.write(fullPath, content);
}

async function writeSeed(relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(seedRepo, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await Bun.write(fullPath, content);
}

async function createSeedGitRemote(): Promise<void> {
  await mkdir(seedRepo, { recursive: true });
  await $`git init -q -b main`.cwd(seedRepo);
  await $`git config user.email "plannotator@example.com"`.cwd(seedRepo);
  await $`git config user.name "Plannotator Test User"`.cwd(seedRepo);

  await writeSeed(".gitignore", lines([
    "node_modules/",
    "dist/",
    ".env",
  ]));
  await writeSeed("package.json", lines([
    "{",
    '  "name": "jj-demo-service",',
    '  "version": "1.0.0",',
    '  "type": "module",',
    '  "scripts": {',
    '    "dev": "bun run src/index.ts",',
    '    "test": "bun test"',
    "  }",
    "}",
  ]));
  await writeSeed("README.md", lines([
    "# JJ Demo Service",
    "",
    "A small service used to exercise Plannotator's JJ review modes.",
  ]));
  await writeSeed("src/index.ts", lines([
    "import { createApp } from './app';",
    "import { loadConfig } from './config';",
    "",
    "const app = createApp(loadConfig());",
    "app.start();",
  ]));
  await writeSeed("src/app.ts", lines([
    "import type { Config } from './config';",
    "import { Router } from './router';",
    "import { createLogger } from './utils/logger';",
    "",
    "export function createApp(config: Config) {",
    "  const router = new Router();",
    "  const logger = createLogger(config.logLevel);",
    "",
    "  router.get('/health', () => ({ status: 200, body: 'ok' }));",
    "",
    "  return {",
    "    start() {",
    "      logger.info(`listening on ${config.port}`);",
    "    },",
    "  };",
    "}",
  ]));
  await writeSeed("src/config.ts", lines([
    "export interface Config {",
    "  port: number;",
    "  logLevel: 'debug' | 'info' | 'warn' | 'error';",
    "}",
    "",
    "export function loadConfig(): Config {",
    "  return {",
    "    port: Number(process.env.PORT ?? 3000),",
    "    logLevel: 'info',",
    "  };",
    "}",
  ]));
  await writeSeed("src/router.ts", lines([
    "type Handler = () => { status: number; body: string };",
    "",
    "export class Router {",
    "  private routes = new Map<string, Handler>();",
    "",
    "  get(path: string, handler: Handler) {",
    "    this.routes.set(`GET ${path}`, handler);",
    "  }",
    "",
    "  list() {",
    "    return [...this.routes.keys()];",
    "  }",
    "}",
  ]));
  await writeSeed("src/utils/format.ts", lines([
    "export function titleCase(value: string): string {",
    "  return value",
    "    .split(' ')",
    "    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))",
    "    .join(' ');",
    "}",
    "",
    "export function truncate(value: string, maxLength: number): string {",
    "  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;",
    "}",
  ]));
  await writeSeed("src/utils/logger.ts", lines([
    "export function createLogger(level: string) {",
    "  return {",
    "    info(message: string) {",
    "      if (level !== 'error') console.log(message);",
    "    },",
    "    error(message: string) {",
    "      console.error(message);",
    "    },",
    "  };",
    "}",
  ]));
  await writeSeed("src/utils/math.ts", lines([
    "export function clamp(value: number, min: number, max: number): number {",
    "  return Math.min(max, Math.max(min, value));",
    "}",
  ]));
  await writeSeed("src/shared/http/client.ts", lines([
    "export interface HttpRequestOptions {",
    "  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';",
    "  headers?: Record<string, string>;",
    "  body?: unknown;",
    "}",
    "",
    "export async function requestJson<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {",
    "  const response = await fetch(url, {",
    "    method: options.method ?? 'GET',",
    "    headers: {",
    "      'content-type': 'application/json',",
    "      ...options.headers,",
    "    },",
    "    body: options.body === undefined ? undefined : JSON.stringify(options.body),",
    "  });",
    "",
    "  if (!response.ok) {",
    "    throw new Error(`Request failed: ${response.status}`);",
    "  }",
    "",
    "  return response.json() as Promise<T>;",
    "}",
  ]));
  await writeSeed("src/features/projects/domain/project.ts", lines([
    "export type ProjectStatus = 'active' | 'paused' | 'archived';",
    "",
    "export interface Project {",
    "  id: string;",
    "  slug: string;",
    "  name: string;",
    "  status: ProjectStatus;",
    "  ownerId: string;",
    "  updatedAt: string;",
    "}",
    "",
    "export function isArchived(project: Project): boolean {",
    "  return project.status === 'archived';",
    "}",
  ]));
  await writeSeed("src/features/projects/repositories/project-repository.ts", lines([
    "import type { Project } from '../domain/project';",
    "",
    "const projects: Project[] = [",
    "  {",
    "    id: 'proj_001',",
    "    slug: 'website-refresh',",
    "    name: 'Website Refresh',",
    "    status: 'active',",
    "    ownerId: 'user_001',",
    "    updatedAt: '2026-05-01T10:00:00.000Z',",
    "  },",
    "  {",
    "    id: 'proj_002',",
    "    slug: 'billing-cleanup',",
    "    name: 'Billing Cleanup',",
    "    status: 'paused',",
    "    ownerId: 'user_002',",
    "    updatedAt: '2026-04-28T16:30:00.000Z',",
    "  },",
    "];",
    "",
    "export async function listProjects(): Promise<Project[]> {",
    "  return [...projects];",
    "}",
  ]));
  await writeSeed("src/features/projects/services/project-service.ts", lines([
    "import { isArchived } from '../domain/project';",
    "import { listProjects } from '../repositories/project-repository';",
    "",
    "export async function listVisibleProjects() {",
    "  const projects = await listProjects();",
    "  return projects.filter((project) => !isArchived(project));",
    "}",
  ]));
  await writeSeed("src/features/projects/routes.ts", lines([
    "import type { Router } from '../../router';",
    "import { listVisibleProjects } from './services/project-service';",
    "",
    "export function registerProjectRoutes(router: Router) {",
    "  router.get('/projects', async () => {",
    "    const projects = await listVisibleProjects();",
    "    return { status: 200, body: JSON.stringify({ projects }) };",
    "  });",
    "}",
  ]));
  await writeSeed("src/features/projects/components/project-summary.ts", lines([
    "import type { Project } from '../domain/project';",
    "",
    "export function renderProjectSummary(project: Project): string {",
    "  return `${project.name} (${project.status})`;",
    "}",
  ]));
  await writeSeed("src/features/projects/legacy/project-exporter.ts", lines([
    "import type { Project } from '../domain/project';",
    "",
    "export function exportProjectCsv(projects: Project[]): string {",
    "  return projects.map((project) => `${project.id},${project.name},${project.status}`).join('\\n');",
    "}",
  ]));
  await writeSeed("src/features/billing/invoices/domain/invoice.ts", lines([
    "export interface Invoice {",
    "  id: string;",
    "  accountId: string;",
    "  totalCents: number;",
    "  dueAt: string;",
    "}",
    "",
    "export function isOverdue(invoice: Invoice, now = new Date()): boolean {",
    "  return new Date(invoice.dueAt).getTime() < now.getTime();",
    "}",
  ]));
  await writeSeed("docs/runbooks/deployments/rollback.md", lines([
    "# Rollback Runbook",
    "",
    "1. Confirm the failing release.",
    "2. Roll back the deployment.",
    "3. Notify the owning team.",
  ]));

  await $`git add -A`.cwd(seedRepo).quiet();
  await $`git commit -q -m "initial service"`.cwd(seedRepo);
  await $`git init -q --bare ${originRepo}`;
  await $`git remote add origin ${originRepo}`.cwd(seedRepo);
  await $`git push -q -u origin main`.cwd(seedRepo);
}

async function createJjWorkspace(): Promise<void> {
  await $`jj git clone --colocate ${originRepo} ${jjRepo}`.quiet();
  await $`jj config set --repo user.name ${JSON.stringify("Plannotator Test User")}`.cwd(jjRepo).quiet();
  await $`jj config set --repo user.email ${JSON.stringify("plannotator@example.com")}`.cwd(jjRepo).quiet();

  // Change 1: committed JJ change after trunk(). This is what jj-last should show.
  await write("src/app.ts", lines([
    "import type { Config } from './config';",
    "import { Router } from './router';",
    "import { registerProjectRoutes } from './features/projects/routes';",
    "import { createLogger } from './utils/logger';",
    "import { createRequestContext } from './middleware/request-context';",
    "",
    "export function createApp(config: Config) {",
    "  const router = new Router();",
    "  const logger = createLogger(config.logLevel);",
    "",
    "  router.get('/health', () => ({ status: 200, body: 'ok' }));",
    "  router.get('/ready', () => ({ status: 200, body: 'ready' }));",
    "  registerProjectRoutes(router);",
    "",
    "  return {",
    "    start() {",
    "      const context = createRequestContext('startup');",
    "      logger.info(`listening on ${config.port}`, context);",
    "    },",
    "  };",
    "}",
  ]));
  await write("src/middleware/request-context.ts", lines([
    "export interface RequestContext {",
    "  requestId: string;",
    "  startedAt: number;",
    "}",
    "",
    "export function createRequestContext(prefix = 'req'): RequestContext {",
    "  return {",
    "    requestId: `${prefix}-${crypto.randomUUID()}`,",
    "    startedAt: Date.now(),",
    "  };",
    "}",
  ]));
  await write("src/features/projects/domain/project-permissions.ts", lines([
    "import type { Project } from './project';",
    "",
    "export interface ProjectPermissions {",
    "  canRead: boolean;",
    "  canWrite: boolean;",
    "  canArchive: boolean;",
    "}",
    "",
    "export function permissionsFor(project: Project, actorId: string): ProjectPermissions {",
    "  const isOwner = project.ownerId === actorId;",
    "  const isArchived = project.status === 'archived';",
    "  return {",
    "    canRead: isOwner || !isArchived,",
    "    canWrite: isOwner && !isArchived,",
    "    canArchive: isOwner && project.status !== 'archived',",
    "  };",
    "}",
  ]));
  await write("src/features/projects/services/project-service.ts", lines([
    "import { isArchived } from '../domain/project';",
    "import { permissionsFor } from '../domain/project-permissions';",
    "import { listProjects } from '../repositories/project-repository';",
    "",
    "export async function listVisibleProjects(actorId = 'anonymous') {",
    "  const projects = await listProjects();",
    "  return projects",
    "    .filter((project) => !isArchived(project))",
    "    .map((project) => ({",
    "      ...project,",
    "      permissions: permissionsFor(project, actorId),",
    "    }));",
    "}",
    "",
    "export async function listRecentProjectSlugs(limit = 10): Promise<string[]> {",
    "  const projects = await listProjects();",
    "  return projects",
    "    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))",
    "    .slice(0, limit)",
    "    .map((project) => project.slug);",
    "}",
  ]));
  await write("src/features/projects/routes.ts", lines([
    "import type { Router } from '../../router';",
    "import { listRecentProjectSlugs, listVisibleProjects } from './services/project-service';",
    "",
    "export function registerProjectRoutes(router: Router) {",
    "  router.get('/projects', async () => {",
    "    const projects = await listVisibleProjects('user_001');",
    "    return { status: 200, body: JSON.stringify({ projects }) };",
    "  });",
    "",
    "  router.get('/projects/recent', async () => {",
    "    const slugs = await listRecentProjectSlugs(5);",
    "    return { status: 200, body: JSON.stringify({ slugs }) };",
    "  });",
    "}",
  ]));
  await write("src/features/billing/invoices/services/invoice-aging-service.ts", lines([
    "import { isOverdue, type Invoice } from '../domain/invoice';",
    "",
    "export interface InvoiceAgingBucket {",
    "  label: string;",
    "  invoices: Invoice[];",
    "}",
    "",
    "export function bucketInvoicesByAge(invoices: Invoice[], now = new Date()): InvoiceAgingBucket[] {",
    "  const overdue = invoices.filter((invoice) => isOverdue(invoice, now));",
    "  const current = invoices.filter((invoice) => !isOverdue(invoice, now));",
    "  return [",
    "    { label: 'overdue', invoices: overdue },",
    "    { label: 'current', invoices: current },",
    "  ];",
    "}",
  ]));
  await $`jj commit -m "feat: add request context middleware"`.cwd(jjRepo).quiet();
  await $`jj bookmark create review/jj-demo -r @-`.cwd(jjRepo).quiet();

  // Change 2: current working-copy change (@). This is what jj-current should show.
  await write("src/config.ts", lines([
    "export interface Config {",
    "  port: number;",
    "  logLevel: 'debug' | 'info' | 'warn' | 'error';",
    "  enableRequestTracing: boolean;",
    "}",
    "",
    "export function loadConfig(): Config {",
    "  return {",
    "    port: Number(process.env.PORT ?? 3000),",
    "    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) ?? 'info',",
    "    enableRequestTracing: process.env.REQUEST_TRACING === '1',",
    "  };",
    "}",
  ]));
  await write("src/utils/logger.ts", lines([
    "export function createLogger(level: string) {",
    "    return {",
    "        info(message: string, data?: unknown) {",
    "            if (level !== 'error') console.log(message, data ?? '');",
    "        },",
    "        warn(message: string, data?: unknown) {",
    "            if (level !== 'error') console.warn(message, data ?? '');",
    "        },",
    "        error(message: string, data?: unknown) {",
    "            console.error(message, data ?? '');",
    "        },",
    "    };",
    "}",
  ]));
  await rename(
    path.join(jjRepo, "src/utils/format.ts"),
    path.join(jjRepo, "src/utils/text.ts"),
  );
  await write("src/utils/text.ts", lines([
    "export function titleCase(value: string): string {",
    "  return value",
    "    .trim()",
    "    .split(/\\s+/)",
    "    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))",
    "    .join(' ');",
    "}",
    "",
    "export function truncate(value: string, maxLength: number): string {",
    "  if (maxLength < 4) return value.slice(0, maxLength);",
    "  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;",
    "}",
    "",
    "export function slugify(value: string): string {",
    "  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');",
    "}",
  ]));
  await rm(path.join(jjRepo, "src/utils/math.ts"));
  await write("src/services/audit-log.ts", lines([
    "export interface AuditEvent {",
    "  type: string;",
    "  actor: string;",
    "  createdAt: string;",
    "}",
    "",
    "export function recordAuditEvent(type: string, actor = 'system'): AuditEvent {",
    "  return {",
    "    type,",
    "    actor,",
    "    createdAt: new Date().toISOString(),",
    "  };",
    "}",
  ]));
  await write("src/features/projects/repositories/project-repository.ts", lines([
    "import type { Project } from '../domain/project';",
    "",
    "const projectsBySlug = new Map<string, Project>([",
    "  ['website-refresh', {",
    "    id: 'proj_001',",
    "    slug: 'website-refresh',",
    "    name: 'Website Refresh',",
    "    status: 'active',",
    "    ownerId: 'user_001',",
    "    updatedAt: '2026-05-01T10:00:00.000Z',",
    "  }],",
    "  ['billing-cleanup', {",
    "    id: 'proj_002',",
    "    slug: 'billing-cleanup',",
    "    name: 'Billing Cleanup',",
    "    status: 'paused',",
    "    ownerId: 'user_002',",
    "    updatedAt: '2026-04-28T16:30:00.000Z',",
    "  }],",
    "]);",
    "",
    "export async function listProjects(): Promise<Project[]> {",
    "  return [...projectsBySlug.values()].map((project) => ({ ...project }));",
    "}",
    "",
    "export async function findProjectBySlug(slug: string): Promise<Project | null> {",
    "  const project = projectsBySlug.get(slug);",
    "  return project ? { ...project } : null;",
    "}",
    "",
    "export async function saveProject(project: Project): Promise<void> {",
    "  projectsBySlug.set(project.slug, { ...project });",
    "}",
  ]));
  await write("src/features/projects/api/v1/types.ts", lines([
    "export interface ProjectReportRequest {",
    "  slug: string;",
    "  includeArchived?: boolean;",
    "  format?: 'json' | 'csv';",
    "}",
    "",
    "export interface ProjectReportResponse {",
    "  slug: string;",
    "  generatedAt: string;",
    "  rows: Array<Record<string, string>>;",
    "}",
  ]));
  await write("src/features/projects/api/v1/serializers/project-serializer.ts", lines([
    "import type { Project } from '../../../domain/project';",
    "",
    "export function serializeProject(project: Project) {",
    "  return {",
    "    id: project.id,",
    "    slug: project.slug,",
    "    displayName: project.name,",
    "    status: project.status,",
    "    links: {",
    "      self: `/api/v1/projects/${project.slug}`,",
    "      report: `/api/v1/projects/${project.slug}/report`,",
    "    },",
    "  };",
    "}",
  ]));
  await write("src/features/projects/api/v1/handlers/export-project-report.ts", lines([
    "import { findProjectBySlug } from '../../../repositories/project-repository';",
    "import { serializeProject } from '../serializers/project-serializer';",
    "import type { ProjectReportRequest, ProjectReportResponse } from '../types';",
    "",
    "export async function exportProjectReport(request: ProjectReportRequest): Promise<ProjectReportResponse> {",
    "  const project = await findProjectBySlug(request.slug);",
    "  if (!project) {",
    "    throw new Error(`Project not found: ${request.slug}`);",
    "  }",
    "",
    "  const serialized = serializeProject(project);",
    "  return {",
    "    slug: serialized.slug,",
    "    generatedAt: new Date().toISOString(),",
    "    rows: [",
    "      { field: 'name', value: serialized.displayName },",
    "      { field: 'status', value: serialized.status },",
    "      { field: 'self', value: serialized.links.self },",
    "    ],",
    "  };",
    "}",
  ]));
  await write("src/features/projects/jobs/nightly/archive-stale-projects.ts", lines([
    "import { listProjects, saveProject } from '../../repositories/project-repository';",
    "",
    "const STALE_AFTER_DAYS = 120;",
    "",
    "export async function archiveStaleProjects(now = new Date()): Promise<number> {",
    "  const projects = await listProjects();",
    "  let archived = 0;",
    "",
    "  for (const project of projects) {",
    "    const ageMs = now.getTime() - new Date(project.updatedAt).getTime();",
    "    const ageDays = ageMs / (1000 * 60 * 60 * 24);",
    "    if (project.status === 'paused' && ageDays > STALE_AFTER_DAYS) {",
    "      await saveProject({ ...project, status: 'archived' });",
    "      archived += 1;",
    "    }",
    "  }",
    "",
    "  return archived;",
    "}",
  ]));
  await write("src/features/billing/invoices/domain/invoice.ts", lines([
    "export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void';",
    "",
    "export interface Invoice {",
    "  id: string;",
    "  accountId: string;",
    "  totalCents: number;",
    "  status: InvoiceStatus;",
    "  dueAt: string;",
    "}",
    "",
    "export function isOverdue(invoice: Invoice, now = new Date()): boolean {",
    "  return invoice.status === 'open' && new Date(invoice.dueAt).getTime() < now.getTime();",
    "}",
  ]));
  await write("src/features/billing/invoices/repositories/invoice-repository.ts", lines([
    "import type { Invoice } from '../domain/invoice';",
    "",
    "export async function listOpenInvoices(accountId: string): Promise<Invoice[]> {",
    "  return [",
    "    {",
    "      id: 'inv_001',",
    "      accountId,",
    "      totalCents: 24000,",
    "      status: 'open',",
    "      dueAt: '2026-05-15T00:00:00.000Z',",
    "    },",
    "  ];",
    "}",
  ]));
  await write("src/shared/http/client.ts", lines([
    "export interface HttpRequestOptions {",
    "    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';",
    "    headers?: Record<string, string>;",
    "    body?: unknown;",
    "}",
    "",
    "export async function requestJson<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {",
    "    const response = await fetch(url, {",
    "        method: options.method ?? 'GET',",
    "        headers: {",
    "            'content-type': 'application/json',",
    "            ...options.headers,",
    "        },",
    "        body: options.body === undefined ? undefined : JSON.stringify(options.body),",
    "    });",
    "",
    "    if (!response.ok) {",
    "        throw new Error(`Request failed: ${response.status}`);",
    "    }",
    "",
    "    return response.json() as Promise<T>;",
    "}",
  ]));
  await mkdir(path.join(jjRepo, "src/features/projects/ui"), { recursive: true });
  await rename(
    path.join(jjRepo, "src/features/projects/components/project-summary.ts"),
    path.join(jjRepo, "src/features/projects/ui/project-summary-card.ts"),
  );
  await write("src/features/projects/ui/project-summary-card.ts", lines([
    "import type { Project } from '../domain/project';",
    "",
    "export function renderProjectSummaryCard(project: Project): string {",
    "  const badge = project.status === 'active' ? 'green' : 'gray';",
    "  return `<article data-status=\"${project.status}\" data-badge=\"${badge}\">${project.name}</article>`;",
    "}",
  ]));
  await rm(path.join(jjRepo, "src/features/projects/legacy/project-exporter.ts"));
  await write("docs/runbooks/projects/export-reports.md", lines([
    "# Project Report Exports",
    "",
    "Project reports are generated from `/api/v1/projects/:slug/report`.",
    "",
    "## Manual Checks",
    "",
    "1. Confirm the project slug exists.",
    "2. Generate a JSON report.",
    "3. Validate links in the serialized payload.",
  ]));

  // Force JJ to snapshot the current working-copy change before Plannotator reads it.
  await $`jj status`.cwd(jjRepo).quiet();
}

async function printSandboxSummary(): Promise<void> {
  const log = await $`jj log --no-graph -T 'change_id.short() ++ " " ++ commit_id.short() ++ " " ++ bookmarks ++ " " ++ remote_bookmarks ++ " " ++ description.first_line() ++ "\n"'`.cwd(jjRepo).quiet();
  const status = await $`jj status`.cwd(jjRepo).quiet();

  console.error("Sandbox created:");
  console.error(`  root:       ${sandbox}`);
  console.error(`  jj repo:    ${jjRepo}`);
  console.error(`  git remote: ${originRepo}`);
  console.error("");
  console.error("JJ graph:");
  console.error(log.text().trimEnd());
  console.error("");
  console.error("JJ status:");
  console.error(status.text().trimEnd());
  console.error("");
  console.error("Useful manual commands:");
  console.error(`  cd ${jjRepo}`);
  console.error("  jj diff --git -r @");
  console.error("  jj diff --git -r @-");
  console.error("  jj diff --git --from 'heads(::@ & ::(trunk()))' --to @");
  console.error("  jj diff --git --from 'root()' --to @");
  console.error("  jj diff --git -w -r @");
  console.error("  jj git push --dry-run --bookmark review/jj-demo");
  console.error("");
}

if (!(await $`command -v jj`.quiet().nothrow()).stdout.length) {
  console.error("jj is required for this manual sandbox but was not found on PATH.");
  process.exit(1);
}

console.error("=== JJ Review Test ===");
console.error("");

await mkdir(sandbox, { recursive: true });
await createSeedGitRemote();
await createJjWorkspace();
await printSandboxSummary();

if (SETUP_ONLY) {
  console.error("--setup-only supplied; not starting the review server.");
  process.exit(0);
}

const gitContext = await getVcsContext(jjRepo);
const initialDiffType = resolveInitialDiffType(gitContext, "merge-base");
const diffResult = await runVcsDiff(initialDiffType, gitContext.defaultBranch, gitContext.cwd, {
  hideWhitespace: false,
});

console.error("Starting review server...");
console.error("Browser should open automatically.");
console.error("");
console.error("Expected initial state:");
console.error("  - VCS type: jj");
console.error("  - Initial View: Current change");
console.error("  - Base for Line of work: trunk()");
console.error("");

const server = await startReviewServer({
  rawPatch: diffResult.patch,
  gitRef: diffResult.label,
  error: diffResult.error,
  origin: "claude-code",
  diffType: initialDiffType,
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
  await rm(sandbox, { recursive: true, force: true });
  console.error("Done.");
} else {
  console.error("");
  console.error(`Sandbox kept at: ${sandbox}`);
  console.error("To clean up manually:");
  console.error(`  rm -rf ${sandbox}`);
}

process.exit(0);
