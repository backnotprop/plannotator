#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Import audit engine
const { auditThemes } = await import(
  path.join(repoRoot, 'packages/ui/audit/index.ts')
);

function parseArgs(args) {
  const parsed = {
    format: 'json',
    output: null,
    theme: null,
    help: false,
    strict: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--format' && i + 1 < args.length) {
      parsed.format = args[++i].toLowerCase();
    } else if (arg.startsWith('--format=')) {
      parsed.format = arg.split('=')[1].toLowerCase();
    } else if (arg === '--output' && i + 1 < args.length) {
      parsed.output = args[++i];
    } else if (arg.startsWith('--output=')) {
      parsed.output = arg.split('=')[1];
    } else if (arg === '--theme' && i + 1 < args.length) {
      parsed.theme = args[++i];
    } else if (arg.startsWith('--theme=')) {
      parsed.theme = arg.split('=')[1];
    } else if (arg === '--strict') {
      parsed.strict = true;
    } else if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    }
  }

  return parsed;
}

function generateHtmlReport(report) {
  const title = `Plannotator Theme WCAG 2.2 Audit Report`;
  const passingVariants = report.variants.filter((v) => v.passed).length;
  const totalVariants = report.variants.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    :root {
      --bg: #0f172a;
      --fg: #f8fafc;
      --card: #1e293b;
      --border: #334155;
      --muted: #94a3b8;
      --pass: #10b981;
      --fail: #ef4444;
      --accent: #6366f1;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      margin: 0;
      padding: 2rem;
      line-height: 1.5;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1, h2, h3 { color: #fff; }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
    }
    .metric { font-size: 2rem; font-weight: bold; margin-top: 0.5rem; }
    .metric.pass { color: var(--pass); }
    .metric.fail { color: var(--fail); }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: rgba(0,0,0,0.2); font-size: 0.85rem; text-transform: uppercase; color: var(--muted); }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge.pass { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .badge.fail { background: rgba(239, 68, 68, 0.2); color: #f87171; }
    .swatch {
      display: inline-block;
      width: 14px;
      height: 14px;
      border-radius: 3px;
      vertical-align: middle;
      margin-right: 4px;
      border: 1px solid rgba(255,255,255,0.2);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p style="color: var(--muted)">Generated: ${report.timestamp} across ${report.totalThemes} themes (${report.totalVariants} variants)</p>

    <div class="summary">
      <div class="card">
        <div>Theme Variants</div>
        <div class="metric ${passingVariants === totalVariants ? 'pass' : 'fail'}">${passingVariants} / ${totalVariants}</div>
      </div>
      <div class="card">
        <div>Evaluated States</div>
        <div class="metric">${report.totalEvaluatedStates}</div>
      </div>
      <div class="card">
        <div>Compliance Rate</div>
        <div class="metric ${report.complianceRate === 100 ? 'pass' : 'fail'}">${report.complianceRate}%</div>
      </div>
      <div class="card">
        <div>Failed States</div>
        <div class="metric ${report.failedStates === 0 ? 'pass' : 'fail'}">${report.failedStates}</div>
      </div>
    </div>

    ${report.variants
      .map(
        (v) => `
      <div class="card" style="margin-bottom: 1.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <h2>${v.themeName} (${v.mode}) <span style="font-size: 0.9rem; color: var(--muted); font-weight: normal;">${v.key}</span></h2>
          <span class="badge ${v.passed ? 'pass' : 'fail'}">${v.passed ? '100% PASS' : `${v.failedCount} FAILURES`}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Semantic State</th>
              <th>Category</th>
              <th>Criterion</th>
              <th>Colors (FG / BG)</th>
              <th>Ratio</th>
              <th>Target</th>
              <th>Status</th>
              <th>Suggestion</th>
            </tr>
          </thead>
          <tbody>
            ${v.states
              .map(
                (s) => `
              <tr>
                <td><strong>${s.name}</strong><br><small style="color: var(--muted)">${s.id}</small></td>
                <td>${s.category}</td>
                <td>${s.criterion}</td>
                <td>
                  <span class="swatch" style="background: ${s.fgHex};"></span><code>${s.fgHex}</code> on
                  <span class="swatch" style="background: ${s.bgHex};"></span><code>${s.bgHex}</code>
                </td>
                <td style="font-weight: bold; color: ${s.passed ? '#34d399' : '#f87171'}">${s.ratio}:1</td>
                <td>${s.targetRatio}:1</td>
                <td><span class="badge ${s.passed ? 'pass' : 'fail'}">${s.passed ? 'PASS' : 'FAIL'}</span></td>
                <td>${s.suggestion ? `<code>${s.suggestion.hex}</code> (${s.suggestion.ratio}:1)` : '—'}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `
      )
      .join('')}
  </div>
</body>
</html>`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(`Usage: theme-audit [options]

Options:
  --format <json|html>   Output format (default: json)
  --output <path>        Write report to file (default: stdout)
  --theme <id>[:<mode>]  Filter by theme id and optional mode
  --strict               Exit with non-zero code if any failures exist
  -h, --help             Show this help message
`);
    process.exit(0);
  }

  const report = {
    ...auditThemes({
      themeFilter: opts.theme || undefined,
      repoRoot,
    }),
    timestamp: new Date().toISOString(),
  };

  // Check diagnostic errors
  if (report.diagnosticErrors.length > 0) {
    console.error('Audit encountered diagnostic errors:');
    for (const err of report.diagnosticErrors) {
      console.error('  - ' + err);
    }
    process.exit(1);
  }

  if (report.orphanedFiles.length > 0) {
    console.error('Orphaned theme stylesheet files found:');
    for (const f of report.orphanedFiles) {
      console.error('  - ' + f);
    }
    process.exit(1);
  }

  if (report.missingSelectors.length > 0) {
    console.error('Registered themes missing stylesheets:');
    for (const m of report.missingSelectors) {
      console.error('  - ' + m);
    }
    process.exit(1);
  }

  let formattedOutput = '';
  if (opts.format === 'html') {
    formattedOutput = generateHtmlReport(report);
  } else {
    formattedOutput = JSON.stringify(report, null, 2);
  }

  if (opts.output && opts.output !== '-') {
    const outDir = path.dirname(path.resolve(opts.output));
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(opts.output, formattedOutput, 'utf-8');
    console.error(
      `Theme audit report written to ${opts.output} (${report.complianceRate}% compliance across ${report.totalVariants} variants)`
    );
  } else {
    process.stdout.write(formattedOutput);
    if (!formattedOutput.endsWith('\n')) process.stdout.write('\n');
  }

  if (opts.strict && !report.allPassed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error running theme audit:', err);
  process.exit(1);
});
