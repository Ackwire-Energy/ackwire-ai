import { expect, test } from "bun:test";
import { clientIp } from "../src/http/client-ip";

test("a public client behind a proxy that appends its own internal hop", () => {
  expect(clientIp("203.0.113.7, 100.64.0.2", undefined)).toBe("203.0.113.7");
  // Whatever the client put in front is never the key.
  expect(clientIp("10.9.8.7, 203.0.113.7, 100.64.0.2", "198.51.100.1")).toBe("203.0.113.7");
});

test("a tailnet client behind tailscale serve, which sets the header to the client alone", () => {
  expect(clientIp("100.101.102.103", undefined)).toBe("100.101.102.103");
  expect(clientIp("fd7a:115c:a1e0::9001:b818", undefined)).toBe("fd7a:115c:a1e0::9001:b818");
  // Nothing in front sets x-real-ip, so the client can: it must not pick its own key.
  expect(clientIp("100.101.102.103", "203.0.113.50")).toBe("100.101.102.103");
  // Behind a proxy that appends, a made-up internal address in front doesn't win either.
  expect(clientIp("10.0.0.1, 100.101.102.103", undefined)).toBe("100.101.102.103");
});

test("without x-forwarded-for, the x-real-ip a proxy sets", () => {
  expect(clientIp(undefined, " 198.51.100.4 ")).toBe("198.51.100.4");
  expect(clientIp("", undefined)).toBe("unknown");
});
