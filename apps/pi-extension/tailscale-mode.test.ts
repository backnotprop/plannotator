import { afterEach, describe, expect, test } from "bun:test";
import type { TailscaleRunner } from "./generated/tailscale.ts";
import { resetTailscaleServeForTests } from "./generated/tailscale-serve.ts";
import {
	isTailscaleModeEnabled,
	publishBrowserServerOverTailscale,
	resetTailscaleModeForTests,
	setTailscaleModeEnabled,
} from "./tailscale-mode.ts";

afterEach(() => {
	resetTailscaleModeForTests();
	resetTailscaleServeForTests();
});

describe("Pi Tailscale mode", () => {
	test("is disabled until the slash command enables it", () => {
		expect(isTailscaleModeEnabled()).toBe(false);
		setTailscaleModeEnabled(true);
		expect(isTailscaleModeEnabled()).toBe(true);
		setTailscaleModeEnabled(false);
		expect(isTailscaleModeEnabled()).toBe(false);
	});

	test("publishes and removes the serve mapping with the browser session", () => {
		setTailscaleModeEnabled(true);
		const calls: string[][] = [];
		const run: TailscaleRunner = (args) => {
			calls.push(args);
			if (args[0] === "serve" && args[1] === "status") {
				return { status: 0, stdout: "null", stderr: "" };
			}
			if (args.at(-1) === "off") {
				return { status: 0, stdout: "", stderr: "" };
			}
			return {
				status: 0,
				stdout: "Available within your tailnet:\nhttps://phone-test.tailnet.ts.net:43123/",
				stderr: "",
			};
		};
		let serverStops = 0;
		const published = publishBrowserServerOverTailscale({
			port: 43123,
			url: "http://localhost:43123",
			stop: () => { serverStops += 1; },
		}, run);

		expect(published.url).toBe("https://phone-test.tailnet.ts.net:43123");
		expect(calls).toEqual([
			["serve", "status", "--json"],
			["serve", "--bg", "--https=43123", "http://127.0.0.1:43123"],
		]);

		published.stop();
		published.stop();
		expect(calls.at(-1)).toEqual(["serve", "--https=43123", "off"]);
		expect(serverStops).toBe(1);
	});

	test("stops the local server when publishing fails", () => {
		setTailscaleModeEnabled(true);
		let serverStops = 0;
		const run: TailscaleRunner = () => ({
			status: null,
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("missing"), { code: "ENOENT" }),
		});

		expect(() => publishBrowserServerOverTailscale({
			port: 43123,
			url: "http://localhost:43123",
			stop: () => { serverStops += 1; },
		}, run)).toThrow("tailscale` CLI not found");
		expect(serverStops).toBe(1);
	});
});
