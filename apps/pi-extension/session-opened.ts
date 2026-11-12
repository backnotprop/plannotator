import { browserNoneReason, resolveBrowserIntent } from "./generated/browser-intent.ts";
import { isLocalOnlyAdvertisedUrl } from "./generated/advertised-url.ts";
import { isRemoteSession } from "./server/network.ts";

export function sessionOpenedMessage(label: string, url: string): string {
	const intent = resolveBrowserIntent(process.env);
	const tail = intent.kind === "none"
		? ` ${browserNoneReason(intent)} You can keep chatting while it runs.`
		: " You can keep chatting while it runs.";
	if (!isRemoteSession()) return `${label} at ${url}.${tail}`;
	return !isLocalOnlyAdvertisedUrl(url)
		? `${label} — open ${url} on your device.${tail}`
		: `${label} — open ${url} on your local machine (forward the port if needed).${tail}`;
}
