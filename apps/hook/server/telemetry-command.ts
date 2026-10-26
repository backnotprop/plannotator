/**
 * `plannotator telemetry` (unreleased, HIDDEN_SUBCOMMANDS): usage counts for
 * experimental features (packages/shared/usage-counts.ts).
 *
 *  - `--show`: every counted feature's state, today's counts so far, the
 *    batches waiting printed as the exact bodies that would be sent, and the
 *    last batches sent. Reads only; no network.
 *  - `--off [--feature <id>]`: counts off in config.json, unsent counts deleted.
 *  - `--on [--feature <id>]`: counts back to the default (on while the feature
 *    is on). `PLANNOTATOR_TELEMETRY=0` and `DO_NOT_TRACK=1` still win.
 *  - `--send` (for tests and the owner): send the waiting batches now, past
 *    the hourly window. Every on/off rule still holds, and a build that is not
 *    a release sends only to a loopback `PLANNOTATOR_TELEMETRY_URL`.
 *  - `--json` with `--show` or `--send`.
 *
 * Exit 0 done, 1 a send that failed, 2 usage.
 */
import { buildUsageCountsRequest, USAGE_COUNTS_HOST, usageCountFeature } from "@plannotator/core/usage-counts";
import {
  describeUsageCounts,
  sendUsageCounts,
  setUsageCounts,
  usageCountsEnvBlock,
  type UsageCountsReason,
  type UsageCountsTransport,
} from "@plannotator/shared/usage-counts";
import { TELEMETRY_COMMAND_USAGE } from "./cli";

export interface TelemetryCommandDeps {
  version: string | undefined;
  env?: NodeJS.ProcessEnv;
  now?: number;
  transport?: UsageCountsTransport;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

const REASON_TEXT: Record<UsageCountsReason, string> = {
  on: "on",
  unknown_feature: "not a counted feature",
  feature_off: "off (the feature is off)",
  notice: "off (the counts notice has not been shown for this version)",
  ended: "off (counting ended)",
  PLANNOTATOR_TELEMETRY: "off (PLANNOTATOR_TELEMETRY)",
  DO_NOT_TRACK: "off (DO_NOT_TRACK)",
  config: "off (you turned counts off)",
};

export async function runTelemetryCommand(args: string[], deps: TelemetryCommandDeps): Promise<number> {
  const out = deps.out ?? ((t) => console.log(t));
  const err = deps.err ?? ((t) => console.error(t));
  const env = deps.env ?? process.env;
  const flags = new Set<string>();
  let feature: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--feature") {
      feature = args[++i];
      if (!feature) return usage(err, "--feature needs a feature id");
    } else if (a.startsWith("--feature=")) {
      feature = a.slice("--feature=".length);
    } else if (["--show", "--off", "--on", "--send", "--json", "--help", "-h"].includes(a)) {
      flags.add(a);
    } else {
      return usage(err, `Unknown option: ${a}`);
    }
  }
  if (flags.has("--help") || flags.has("-h")) {
    out(TELEMETRY_COMMAND_USAGE);
    return 0;
  }
  const actions = ["--show", "--off", "--on", "--send"].filter((f) => flags.has(f));
  if (actions.length !== 1) return usage(err, actions.length ? "Pick one of --show, --off, --on, --send." : "");
  if (feature !== undefined && !usageCountFeature(feature)) return usage(err, `Not a counted feature: ${feature}`);
  if (feature !== undefined && (flags.has("--show") || flags.has("--send"))) return usage(err, "--feature goes with --off or --on.");
  const json = flags.has("--json");
  if (json && (flags.has("--off") || flags.has("--on"))) return usage(err, "--json goes with --show or --send.");

  if (flags.has("--off") || flags.has("--on")) {
    const on = flags.has("--on");
    const { saved } = setUsageCounts(on, { feature });
    const which = feature ? `for ${feature}` : "for every feature";
    if (!saved) {
      // config.json was not written (it cannot be read, or is not valid JSON): never report a change that did not persist.
      err(
        `Usage counts were not turned ${on ? "on" : "off"} ${which}: config.json could not be saved. `
        + `A config.json that is not valid JSON is never written over: fix or remove it, then run this again.`
        + (on ? "" : " Counts not sent yet were deleted."),
      );
      return 1;
    }
    if (!on) out(`Usage counts are off ${which}. Counts not sent yet were deleted.`);
    else {
      out(`Usage counts are on ${which} while that feature is on.`);
      const block = usageCountsEnvBlock(env);
      if (block) out(`${block} is set in this environment, so counts stay off here.`);
    }
    return 0;
  }

  if (flags.has("--send")) {
    const result = await sendUsageCounts({ version: deps.version, env, now: deps.now, transport: deps.transport, force: true, log: err });
    if (json) out(JSON.stringify(result));
    else out(`${result.status}: ${result.sent} sent, ${result.dropped} dropped${result.endpoint ? ` (${result.endpoint})` : " (this build sends nowhere)"}`);
    return result.status === "failed" ? 1 : 0;
  }

  const report = describeUsageCounts({ version: deps.version, env, now: deps.now });
  if (json) {
    out(JSON.stringify(report, null, 2));
    return 0;
  }
  const lines: string[] = [];
  lines.push(`Sent to: ${report.endpoint ?? "nowhere (this build neither records nor sends)"}`);
  if (report.envBlock) lines.push(`${report.envBlock} is set: counts are off everywhere.`);
  for (const f of report.features) {
    lines.push("", `${f.name} (${f.id}, revision ${f.rev})`);
    lines.push(`  Feature: ${f.enabled ? "on" : "off"}; notice shown: ${f.noticeShown ? `version ${f.noticeShown}` : "no"} (needs ${f.noticeNeeded})`);
    lines.push(`  Counts: ${REASON_TEXT[f.counts.reason]}; counting ends ${f.collectUntil}`);
    lines.push("  What is counted:");
    for (const e of f.events) lines.push(`    ${e.id}: ${e.label}`);
    const today = Object.entries(f.today);
    lines.push(`  Today so far (stays on this computer until the UTC day ends): ${today.length ? today.map(([k, v]) => `${k} ${v}`).join(", ") : "nothing"}`);
    if (f.waiting.length === 0) lines.push("  Waiting to be sent: nothing");
    else {
      lines.push("  Waiting to be sent, exactly as it would go:");
      for (const b of f.waiting) lines.push(...buildUsageCountsRequest(USAGE_COUNTS_HOST, b.body).split("\r\n").map((l) => `    ${l}`), "");
    }
  }
  lines.push("", report.sent.length ? "Last sent:" : "Last sent: nothing yet");
  for (const s of report.sent.slice(-10)) lines.push(`  ${s.at}  ${s.body}`);
  out(lines.join("\n"));
  return 0;
}

function usage(err: (t: string) => void, message: string): number {
  if (message) err(message);
  err(TELEMETRY_COMMAND_USAGE);
  return 2;
}
