import { doorSessionUrl, newDoorToken, removeDoorSession, writeDoorSession } from "@plannotator/shared/inbox/cf-access-door";
import { allowServedHostname } from "./request-host-guard";
import { setSessionDoor, setSessionTailnetServedUrl } from "./session-tailnet";

export function openSessionDoor(dataDir: string, port: number, host: string): { url: string } {
  const key = newDoorToken();
  const secret = `${newDoorToken()}${newDoorToken()}`;
  writeDoorSession(dataDir, { key, port, pid: process.pid, secret });
  process.on("exit", () => removeDoorSession(dataDir, key));
  setSessionDoor(secret, host);
  setSessionTailnetServedUrl(`https://${host}/`);
  allowServedHostname(host);
  return { url: doorSessionUrl(host, key) };
}

export const CF_ACCESS_SESSION_LINE = "Served through Cloudflare Access: open it on your device (the URL above).";
