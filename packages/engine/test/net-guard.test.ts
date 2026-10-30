import { expect, test } from "bun:test";
import { assertPublicHttpsUrl, isBlockedAddress } from "../src/net-guard";

/**
 * The SSRF guard must classify an address by what the socket connects to, not by
 * how it is spelled. IPv6 has several spellings of the same internal address
 * (hex IPv4-mapped, IPv4-compatible, fully expanded) that a prefix-string check
 * misses, which would let a typed-in URL reach loopback or the cloud metadata IP.
 */

test("blocks internal addresses in every IPv6 spelling", () => {
  const blocked = [
    // Controls that a prefix check already caught.
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "fd00:ec2::254",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    // Spellings a prefix check missed (regression cases).
    "::ffff:7f00:1", // hex IPv4-mapped 127.0.0.1
    "::ffff:a9fe:a9fe", // hex IPv4-mapped 169.254.169.254 (metadata)
    "0:0:0:0:0:0:0:1", // fully expanded loopback
    "0:0:0:0:0:ffff:127.0.0.1", // expanded IPv4-mapped
    "::7f00:1", // IPv4-compatible 127.0.0.1
    "::a9fe:a9fe", // IPv4-compatible 169.254.169.254
    "[::ffff:a9fe:a9fe]", // bracketed literal
  ];
  for (const ip of blocked) expect(isBlockedAddress(ip)).toBe(true);
});

test("still allows public addresses", () => {
  expect(isBlockedAddress("93.184.216.34")).toBe(false);
  expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false); // public IPv6 (Cloudflare DNS)
});

test("assertPublicHttpsUrl refuses a hex IPv4-mapped metadata literal", async () => {
  await expect(assertPublicHttpsUrl("https://[::ffff:a9fe:a9fe]/latest/meta-data/")).rejects.toThrow();
  await expect(assertPublicHttpsUrl("https://[0:0:0:0:0:0:0:1]/")).rejects.toThrow();
});

test("assertPublicHttpsUrl still accepts a public host", async () => {
  const url = await assertPublicHttpsUrl("https://example.com/mcp", async () => ["93.184.216.34"]);
  expect(url.hostname).toBe("example.com");
});
