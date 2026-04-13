import { afterEach, describe, expect, test } from "bun:test";
import { getServerHostname, getServerPort, isRemoteSession } from "./network";

const savedEnv: Record<string, string | undefined> = {};
const envKeys = ["PLANNOTATOR_REMOTE", "PLANNOTATOR_PORT", "SSH_TTY", "SSH_CONNECTION"];

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
	test("uses random local port when false overrides SSH", () => {
		clearEnv();
		process.env.PLANNOTATOR_REMOTE = "false";
		process.env.SSH_TTY = "/dev/pts/0";
		expect(getServerPort()).toEqual({ port: 0, portSource: "random" });
	});

	test("uses default remote port when SSH is detected", () => {
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
