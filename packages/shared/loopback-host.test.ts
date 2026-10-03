import { describe, expect, test } from "bun:test";
import { isLoopbackHostHeader } from "./loopback-host";

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
});
