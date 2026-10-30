import { expect, test } from "bun:test";
import { type BindAttempt, verifyBrowserBindPolicy } from "../../runner/browser-bind-check";

test("checks explicit and dynamic denied binds, and browser plus dev allowed binds, on IPv4 and IPv6", async () => {
  const calls: string[] = [];
  const attempt: BindAttempt = async (host, port) => {
    calls.push(`${host}:${port}`);
    return port === 0 || port === 10000 ? "EPERM" : "bound";
  };
  await verifyBrowserBindPolicy(10000, [12000, 12001, 3000], attempt);
  expect(calls).toEqual([
    "127.0.0.1:10000",
    "127.0.0.1:0",
    "127.0.0.1:12000",
    "127.0.0.1:12001",
    "127.0.0.1:3000",
    "::1:10000",
    "::1:0",
    "::1:12000",
    "::1:12001",
    "::1:3000",
  ]);
});

test("bind(0) fallback success and an unavailable own port both fail closed", async () => {
  const fallback: BindAttempt = async (_host, port) => (port === 10000 ? "EPERM" : "bound");
  await expect(verifyBrowserBindPolicy(10000, [12000, 12001, 3000], fallback)).rejects.toThrow("127.0.0.1:0: bound");
  const noOwnPort: BindAttempt = async (_host, port) => (port === 10000 || port === 0 ? "EACCES" : "EADDRINUSE");
  await expect(verifyBrowserBindPolicy(10000, [12000, 12001, 3000], noOwnPort)).rejects.toThrow("bind allow failed");
});
