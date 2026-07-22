import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { closeServer, occupyConsecutivePorts } from "../../../tests/helpers/ports.ts";
import {
	getServerHostname,
	getServerPort,
	getServerPorts,
	isNoOpBrowserSentinel,
	isRemoteSession,
	listenOnPort,
	openBrowser,
} from "./network.ts";

const savedEnv: Record<string, string | undefined> = {};
const envKeys = [
	"PLANNOTATOR_REMOTE",
	"PLANNOTATOR_PORT",
	"SSH_TTY",
	"SSH_CONNECTION",
	"PLANNOTATOR_BROWSER",
	"BROWSER",
];

function clearEnv() {
	for (const key of envKeys) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
}

afterEach(() => {
	for (const key of envKeys) {
		if (savedEnv[key] !== undefined) {
			process.env[key] = savedEnv[key];
		} else {
			delete process.env[key];
		}
	}
});

describe("pi remote detection", () => {
	test("false by default", () => {
		clearEnv();
		expect(isRemoteSession()).toBe(false);
	});

	test("true when PLANNOTATOR_REMOTE=1", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "1";
		expect(isRemoteSession()).toBe(true);
	});

	test("true when PLANNOTATOR_REMOTE=true", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "true";
		expect(isRemoteSession()).toBe(true);
	});

	test("false when PLANNOTATOR_REMOTE=0", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "0";
		expect(isRemoteSession()).toBe(false);
	});

	test("false when PLANNOTATOR_REMOTE=false", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "false";
		expect(isRemoteSession()).toBe(false);
	});

	test("PLANNOTATOR_REMOTE=false overrides SSH_TTY", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "false";
		process.env.SSH_TTY = "/dev/pts/0";
		expect(isRemoteSession()).toBe(false);
	});

	test("PLANNOTATOR_REMOTE=0 overrides SSH_CONNECTION", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.SSH_CONNECTION = "192.168.1.1 12345 192.168.1.2 22";
		expect(isRemoteSession()).toBe(false);
	});

	test("true when SSH_TTY is set and env var is unset", () => {
		clearEnv();
		process.env.SSH_TTY = "/dev/pts/0";
		expect(isRemoteSession()).toBe(true);
	});
});

describe("pi port selection", () => {
	test("PLANNOTATOR_PORT unset preserves the random local default", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "false";
		process.env.SSH_TTY = "/dev/pts/0";
		expect(getServerPort()).toEqual({ port: 0, portSource: "random" });
	});

	test("PLANNOTATOR_PORT unset preserves the 19432 remote default", () => {
		clearEnv();
		process.env.SSH_CONNECTION = "192.168.1.1 12345 192.168.1.2 22";
		expect(getServerPort()).toEqual({ port: 19432, portSource: "remote-default" });
	});

	test("PLANNOTATOR_PORT still takes precedence", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "false";
		process.env.SSH_TTY = "/dev/pts/0";
		process.env.PLANNOTATOR_PORT = "9999";
		expect(getServerPort()).toEqual({ port: 9999, portSource: "env" });
	});

	test("expands an inclusive port range", () => {
		clearEnv();
		process.env.PLANNOTATOR_PORT = "19432-19435";
		expect(getServerPorts()).toEqual({
			ports: [19432, 19433, 19434, 19435],
			portSource: "env",
		});
		expect(getServerPort()).toEqual({ port: 19432, portSource: "env" });
	});

	test("ignores reversed port ranges", () => {
		clearEnv();
		process.env.PLANNOTATOR_PORT = "19435-19432";
		expect(getServerPorts()).toEqual({ ports: [0], portSource: "random" });
	});

	test("rejects malformed fixed ports and ranges without accepting numeric prefixes", () => {
		clearEnv();
		for (const value of [
			"19432garbage",
			"19432.5",
			"19432-19435garbage",
			"19432-19435-19436",
		]) {
			process.env.PLANNOTATOR_PORT = value;
			expect(getServerPorts()).toEqual({ ports: [0], portSource: "random" });
		}
	});

	test("a malformed range follows the existing remote default path", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "1";
		process.env.PLANNOTATOR_PORT = "19432-19435garbage";
		expect(getServerPorts()).toEqual({
			ports: [19432],
			portSource: "remote-default",
		});
	});

	test("binds the next port when the range start is occupied", async () => {
		clearEnv();
		const { start, servers } = await occupyConsecutivePorts(2);
		await closeServer(servers[1]);
		process.env.PLANNOTATOR_PORT = `${start}-${start + 1}`;
		const server = createServer();
		try {
			expect(await listenOnPort(server)).toEqual({
				port: start + 1,
				portSource: "env",
			});
			expect(server.listenerCount("error")).toBe(0);
			expect(server.listenerCount("listening")).toBe(0);
		} finally {
			await closeServer(server);
			await closeServer(servers[0]);
		}
	});

	test("reports an exhausted occupied range", async () => {
		clearEnv();
		const { start, servers } = await occupyConsecutivePorts(2);
		process.env.PLANNOTATOR_PORT = `${start}-${start + 1}`;
		const server = createServer();

		try {
			await expect(listenOnPort(server)).rejects.toThrow(
				new RegExp(`^Port selection ${start}-${start + 1} exhausted$`),
			);
		} finally {
			await Promise.all(servers.map(closeServer));
		}
	});

	test("treats a valid one-port range as range syntax", async () => {
		clearEnv();
		const { start, servers } = await occupyConsecutivePorts(1);
		process.env.PLANNOTATOR_PORT = `${start}-${start}`;
		const server = createServer();

		try {
			await expect(listenOnPort(server)).rejects.toThrow(
				new RegExp(`^Port selection ${start}-${start} exhausted$`),
			);
		} finally {
			await closeServer(servers[0]);
		}
	});

	test("removes failed-attempt listeners across a long occupied range", async () => {
		clearEnv();
		const { start, servers } = await occupyConsecutivePorts(12);
		process.env.PLANNOTATOR_PORT = `${start}-${start + servers.length - 1}`;
		const server = createServer();

		try {
			await expect(listenOnPort(server)).rejects.toThrow("exhausted");
			expect(server.listenerCount("error")).toBe(0);
			expect(server.listenerCount("listening")).toBe(0);
		} finally {
			await Promise.all(servers.map(closeServer));
		}
	});
});

describe("pi non-range port compatibility", () => {
	test("an occupied fixed port preserves the existing retry error", async () => {
		clearEnv();
		const { start, servers } = await occupyConsecutivePorts(1);
		process.env.PLANNOTATOR_PORT = String(start);
		const server = createServer();

		try {
			await expect(listenOnPort(server)).rejects.toThrow(
				new RegExp(`^Port ${start} in use after 5 retries$`),
			);
			expect(server.listenerCount("error")).toBe(0);
			expect(server.listenerCount("listening")).toBe(0);
		} finally {
			await closeServer(servers[0]);
		}
	});
});

describe("pi server hostname", () => {
	test("binds local sessions to loopback", () => {
		clearEnv();
		expect(getServerHostname()).toBe("127.0.0.1");
	});

	test("binds remote sessions to all interfaces", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "1";
		expect(getServerHostname()).toBe("0.0.0.0");
	});
});

describe("pi browser no-op sentinels", () => {
	test("recognizes no-op values case- and whitespace-insensitively", () => {
		for (const value of [
			"true",
			"false",
			"none",
			":",
			"0",
			"1",
			"TRUE",
			"  none  ",
		]) {
			expect(isNoOpBrowserSentinel(value)).toBe(true);
		}
	});

	test("does not flag real browser handlers or explicit command paths", () => {
		expect(isNoOpBrowserSentinel("/usr/bin/firefox")).toBe(false);
		expect(isNoOpBrowserSentinel("Google Chrome")).toBe(false);
		expect(isNoOpBrowserSentinel("open")).toBe(false);
		expect(isNoOpBrowserSentinel("/usr/bin/true")).toBe(false);
	});

	test("remote BROWSER=true is treated as no browser handler", async () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "1";
		process.env.BROWSER = "true";

		expect(await openBrowser("http://127.0.0.1:19432")).toEqual({
			opened: false,
			isRemote: true,
			url: "http://127.0.0.1:19432",
		});
	});
});
