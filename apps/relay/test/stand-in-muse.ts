import { appendFileSync } from "node:fs";

const [transcript, why] = process.argv.slice(2) as [string, string];

type Row = { thread_id: string; unread?: boolean; last_person_message_id?: string | null };

const call = (action: string, args: Record<string, unknown>) => {
  const run = Bun.spawnSync(["bash", "-c", `export PLANNOTATOR_PAIRING="$(cat ~/.config/plannotator/pairing)"; plannotator inbox call ${action} "$1"`, "muse", JSON.stringify(args)], { env: process.env });
  const out = { action, code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  appendFileSync(transcript, `${JSON.stringify({ why, ...out })}\n`);
  return out;
};

const listed = call("read_thread", {});
if (listed.code !== 0) process.exit(listed.stderr.startsWith("pairing_removed") ? 3 : 0);
const rows = ((JSON.parse(listed.stdout) as { threads?: Row[] }).threads ?? []).filter((row) => row.unread && row.last_person_message_id);
for (const row of rows) {
  const read = call("read_thread", { thread_id: row.thread_id });
  if (read.code !== 0) continue;
  const words = (JSON.parse(read.stdout) as { thread?: { messages?: { id: string; body: string }[] } }).thread?.messages?.find((m) => m.id === row.last_person_message_id)?.body ?? "";
  call("send_message", { reply_to: row.last_person_message_id, body: `Muse here (${why}). You wrote: ${words}` });
}
