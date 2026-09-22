import assert from "node:assert/strict";
import test from "node:test";
import {
	assertPublicAddress,
	fetchRemoteUrl,
	isBlockedIPv4,
	isBlockedIPv6,
	parseAllowRanges,
	parseCidr,
	validateRemoteUrl,
} from "../src/web/ssrf.ts";

const publicLookup = async () => [{ address: "93.184.216.34" }];

test("private, loopback, and reserved IPv4 is blocked", () => {
	for (const address of [
		"0.0.0.0", "10.1.2.3", "127.0.0.1", "100.64.0.1", "100.127.255.255",
		"169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
		"198.18.0.1", "198.19.255.255", "224.0.0.1", "255.255.255.255",
	]) {
		assert.equal(isBlockedIPv4(address), true, `expected ${address} blocked`);
	}
});

test("public IPv4 is allowed, and near-miss ranges are not over-blocked", () => {
	for (const address of ["93.184.216.34", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.167.1.1", "223.255.255.255"]) {
		assert.equal(isBlockedIPv4(address), false, `expected ${address} allowed`);
	}
});

test("malformed IPv4 is treated as blocked, never as allowed", () => {
	for (const address of ["", "1.2.3", "1.2.3.4.5", "1.2.3.256", "a.b.c.d", "-1.0.0.1"]) {
		assert.equal(isBlockedIPv4(address), true, `expected ${address} blocked`);
	}
});

test("internal IPv6 is blocked and public IPv6 is allowed", () => {
	for (const address of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "not-an-ip", ":::1"]) {
		assert.equal(isBlockedIPv6(address), true, `expected ${address} blocked`);
	}
	for (const address of ["2606:2800:220:1:248:1893:25c8:1946", "2001:4860:4860::8888"]) {
		assert.equal(isBlockedIPv6(address), false, `expected ${address} allowed`);
	}
});

test("an IPv4-mapped IPv6 address inherits the IPv4 rules", () => {
	assert.equal(isBlockedIPv6("::ffff:127.0.0.1"), true);
	assert.equal(isBlockedIPv6("::ffff:10.0.0.1"), true);
	assert.equal(isBlockedIPv6("::ffff:169.254.169.254"), true);
	assert.equal(isBlockedIPv6("::ffff:93.184.216.34"), false);
});

test("only http and https can be fetched", async () => {
	for (const url of ["file:///etc/passwd", "ftp://example.com", "gopher://example.com", "data:text/plain,hi"]) {
		await assert.rejects(() => validateRemoteUrl(url, { lookup: publicLookup }), /Only HTTP and HTTPS/);
	}
});

test("loopback hostnames are blocked regardless of DNS", async () => {
	for (const url of ["http://localhost/x", "http://LOCALHOST/x", "http://app.localhost/x", "http://localhost./x"]) {
		await assert.rejects(() => validateRemoteUrl(url, { lookup: publicLookup }), /Blocked internal hostname/);
	}
});

test("a literal private IP in the URL is blocked without a lookup", async () => {
	await assert.rejects(() => validateRemoteUrl("http://127.0.0.1:8080/x"), /Blocked internal address/);
	await assert.rejects(() => validateRemoteUrl("http://169.254.169.254/latest/meta-data/"), /Blocked internal address/);
	await assert.rejects(() => validateRemoteUrl("http://[::1]/x"), /Blocked internal address/);
});

test("DNS rebinding is blocked when any answer is private", async () => {
	const lookup = async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }];
	await assert.rejects(() => validateRemoteUrl("http://evil.example/x", { lookup }), /Blocked internal address/);
});

test("an empty or failing DNS answer is an error, not a pass", async () => {
	await assert.rejects(() => validateRemoteUrl("http://x.example/", { lookup: async () => [] }), /no addresses returned/);
	await assert.rejects(
		() => validateRemoteUrl("http://x.example/", { lookup: async () => { throw new Error("ENOTFOUND"); } }),
		/Failed to resolve x\.example: ENOTFOUND/,
	);
});

test("a public host resolving to public addresses is allowed", async () => {
	const url = await validateRemoteUrl("https://example.com/path?q=1", { lookup: publicLookup });
	assert.equal(url.href, "https://example.com/path?q=1");
});

test("the fake-IP block names the allowRanges fix", async () => {
	await assert.rejects(() => validateRemoteUrl("http://198.18.0.5/"), /ssrf\.allowRanges/);
});

test("allowRanges exempts an otherwise blocked address", async () => {
	const allowRanges = parseAllowRanges(["198.18.0.0/15"]);
	const url = await validateRemoteUrl("http://198.18.0.5/", { allowRanges });
	assert.equal(url.hostname, "198.18.0.5");
	// The exemption is scoped to the range it names.
	await assert.rejects(() => validateRemoteUrl("http://127.0.0.1/", { allowRanges }), /Blocked internal address/);
});

test("a bare IP in allowRanges is a host route, and CIDR boundaries hold", () => {
	assert.doesNotThrow(() => assertPublicAddress("10.0.0.7", "h", parseAllowRanges(["10.0.0.7"])));
	assert.throws(() => assertPublicAddress("10.0.0.8", "h", parseAllowRanges(["10.0.0.7"])), /Blocked/);
	const slash24 = parseAllowRanges(["192.168.5.0/24"]);
	assert.doesNotThrow(() => assertPublicAddress("192.168.5.255", "h", slash24));
	assert.throws(() => assertPublicAddress("192.168.6.0", "h", slash24), /Blocked/);
});

test("an IPv6 allowRange does not exempt an IPv4 address", () => {
	const ranges = parseAllowRanges(["fc00::/7"]);
	assert.doesNotThrow(() => assertPublicAddress("fc00::1", "h", ranges));
	assert.throws(() => assertPublicAddress("10.0.0.1", "h", ranges), /Blocked/);
});

test("a malformed allowRanges entry is rejected loudly", () => {
	for (const entry of ["", "   ", "not-an-ip", "10.0.0.0/", "10.0.0.0/0", "10.0.0.0/33", "10.0.0.0/8/9", "::1/129"]) {
		assert.throws(() => parseCidr(entry), /ssrf\.allowRanges/, `expected ${entry} rejected`);
	}
	assert.throws(() => parseAllowRanges("10.0.0.0/8"), /must be an array/);
	assert.deepEqual(parseAllowRanges(undefined), []);
});

/** Minimal Response stand-ins so redirect handling is tested without a network. */
const redirectTo = (location) => new Response(null, { status: 302, headers: { location } });

test("a redirect into a private address is blocked", async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url.toString());
		return calls.length === 1 ? redirectTo("http://127.0.0.1/admin") : new Response("leaked");
	};
	await assert.rejects(
		() => fetchRemoteUrl("https://example.com/", {}, { fetch: fetchImpl, lookup: publicLookup }),
		/Blocked internal address/,
	);
	assert.equal(calls.length, 1, "the private hop must never be requested");
});

test("a relative redirect is resolved and revalidated", async () => {
	const seen = [];
	const fetchImpl = async (url) => {
		seen.push(url.toString());
		return seen.length === 1 ? redirectTo("/next") : new Response("ok");
	};
	const response = await fetchRemoteUrl("https://example.com/start", {}, { fetch: fetchImpl, lookup: publicLookup });
	assert.equal(await response.text(), "ok");
	assert.deepEqual(seen, ["https://example.com/start", "https://example.com/next"]);
});

test("redirects are capped", async () => {
	let n = 0;
	const fetchImpl = async () => redirectTo(`https://example.com/${n++}`);
	await assert.rejects(
		() => fetchRemoteUrl("https://example.com/", {}, { fetch: fetchImpl, lookup: publicLookup, maxRedirects: 3 }),
		/Too many redirects/,
	);
	assert.equal(n, 4, "one initial request plus three permitted hops");
});

test("a 303 redirect drops the body and becomes a GET", async () => {
	const inits = [];
	const fetchImpl = async (_url, init) => {
		inits.push(init);
		return inits.length === 1 ? new Response(null, { status: 303, headers: { location: "https://example.com/done" } }) : new Response("ok");
	};
	await fetchRemoteUrl("https://example.com/", { method: "POST", body: "secret" }, { fetch: fetchImpl, lookup: publicLookup });
	assert.equal(inits[1].method, "GET");
	assert.equal(inits[1].body, undefined);
});

test("redirects are followed manually so the runtime cannot skip a check", async () => {
	const fetchImpl = async (_url, init) => {
		assert.equal(init.redirect, "manual");
		return new Response("ok");
	};
	await fetchRemoteUrl("https://example.com/", {}, { fetch: fetchImpl, lookup: publicLookup });
});

test("a redirect without a location is returned as-is", async () => {
	const fetchImpl = async () => new Response(null, { status: 302 });
	const response = await fetchRemoteUrl("https://example.com/", {}, { fetch: fetchImpl, lookup: publicLookup });
	assert.equal(response.status, 302);
});
