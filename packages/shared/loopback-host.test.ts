import { describe, expect, test } from "bun:test";
import { isLocalhostSubdomain, isLoopbackForwardedFor, isLoopbackHostHeader } from "./loopback-host";

describe("isLoopbackHostHeader", () => {
	test("accepts loopback names carrying the server's own port", () => {
		for (const host of ["localhost:5000", "LOCALHOST:5000", "127.0.0.1:5000", "127.200.3.4:5000", "[::1]:5000"]) {
			expect(isLoopbackHostHeader(host, 5000)).toBe(true);
		}
	});

	test("refuses rebinding names, other ports, missing ports and malformed values", () => {
		for (const host of [
			"evil.example:5000",
			"127.0.0.1.evil.example:5000",
			"localhost.:5000",
			"0.0.0.0:5000",
			"192.168.1.10:5000",
			"[::ffff:127.0.0.1]:5000",
			"localhost:5001",
			"localhost",
			"[::1]",
			"::1:5000",
			"localhost:5000:5000",
			"localhost:+5000",
			"",
		]) {
			expect(isLoopbackHostHeader(host, 5000)).toBe(false);
		}
		expect(isLoopbackHostHeader(null, 5000)).toBe(false);
		expect(isLoopbackHostHeader("localhost:5000", undefined)).toBe(false);
	});

	test("without a configured name, no localhost subdomain counts (main's behavior, #2184)", () => {
		for (const host of ["plannotator.localhost:5000", "a.b.localhost:5000", "evil.localhost:5000"]) {
			expect(isLoopbackHostHeader(host, 5000)).toBe(false);
			expect(isLoopbackHostHeader(host, 5000, undefined)).toBe(false);
			expect(isLoopbackHostHeader(host, 5000, null)).toBe(false);
		}
	});

	test("the configured localhost subdomain counts, and only it", () => {
		expect(isLoopbackHostHeader("plannotator.localhost:5000", 5000, "plannotator.localhost")).toBe(true);
		expect(isLoopbackHostHeader("Plannotator.Localhost:5000", 5000, "plannotator.localhost")).toBe(true);
		// The plain loopback names still count beside it.
		expect(isLoopbackHostHeader("localhost:5000", 5000, "plannotator.localhost")).toBe(true);
		expect(isLoopbackHostHeader("127.0.0.1:5000", 5000, "plannotator.localhost")).toBe(true);
		for (const host of ["evil.localhost:5000", "x.plannotator.localhost:5000", "plannotator.localhost:5001", "plannotator.localhost"]) {
			expect(isLoopbackHostHeader(host, 5000, "plannotator.localhost")).toBe(false);
		}
	});

	test("a configured name that is not a localhost subdomain widens nothing", () => {
		for (const name of [".localhost", "localhost", "a..localhost", "evil.example", "my-machine.tail1234.ts.net", "100.64.0.9"]) {
			expect(isLoopbackHostHeader(`${name}:5000`, 5000, name)).toBe(name === "localhost");
		}
	});

	test("isLocalhostSubdomain needs a non-empty label in front", () => {
		for (const ok of ["plannotator.localhost", "a.b.localhost", "x-1.LOCALHOST"]) expect(isLocalhostSubdomain(ok)).toBe(true);
		for (const no of ["localhost", ".localhost", "a..localhost", "-a.localhost", "a-.localhost", "localhost.", "plannotator.localhost.evil.example", "a.localhost:5000"]) {
			expect(isLocalhostSubdomain(no)).toBe(false);
		}
	});

	test("isLoopbackForwardedFor", () => {
		expect(isLoopbackForwardedFor("127.0.0.1")).toBe(true);
		expect(isLoopbackForwardedFor("127.0.0.1, 127.0.0.2")).toBe(true);
		expect(isLoopbackForwardedFor("localhost")).toBe(true);
		expect(isLoopbackForwardedFor("::1")).toBe(true);
		expect(isLoopbackForwardedFor("[::1]:52817")).toBe(true);
		expect(isLoopbackForwardedFor("127.0.0.1:8080, [::1]")).toBe(true);

		// Non-loopback
		expect(isLoopbackForwardedFor("100.64.0.9")).toBe(false);
		expect(isLoopbackForwardedFor("127.0.0.1, 100.64.0.9")).toBe(false);
		expect(isLoopbackForwardedFor("192.168.1.50")).toBe(false);
		expect(isLoopbackForwardedFor("example.com")).toBe(false);
		expect(isLoopbackForwardedFor("")).toBe(false);
		expect(isLoopbackForwardedFor(null)).toBe(false);
		expect(isLoopbackForwardedFor(undefined)).toBe(false);
	});
});
