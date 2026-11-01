import { expect, test } from "bun:test";
import { ensureBrowserBindPolicy } from "../../runner/browser-bind-policy";
import type { RunCommand } from "../../runner/service";

const user = { id: "agent-1", user: "ag-a1b2c3d4", uid: 21000 };
const runner = ["/usr/bin/bun", "/opt/agentes/runner.ts"];

test("loads an empty slice, replaces bind rules, and probes denied and allowed ports before worker launch", () => {
  const calls: { file: string; args: string[] }[] = [];
  const run: RunCommand = (file, args) => {
    calls.push({ file, args });
    if (file === "ss")
      return {
        code: 0,
        output:
          "LISTEN 0 0 127.0.0.1:10000 0.0.0.0:* uid:20000 ino:1 sk:0\n" +
          "LISTEN 0 0 127.0.0.1:3000 0.0.0.0:* uid:21001 ino:2 sk:0",
      };
    return { code: 0, output: "" };
  };
  ensureBrowserBindPolicy(user, runner, { run, systemd: true });
  expect(calls[0]).toEqual({ file: "systemctl", args: ["start", "agents-21000.slice"] });
  expect(calls[1]).toEqual({
    file: "systemctl",
    args: [
      "set-property",
      "--runtime",
      "agents-21000.slice",
      "SocketBindAllow=",
      "SocketBindAllow=tcp:1-9999",
      "SocketBindAllow=tcp:30000-65535",
      "SocketBindAllow=tcp:12000-12001",
      "SocketBindDeny=",
      "SocketBindDeny=tcp",
    ],
  });
  expect(calls[2]).toEqual({ file: "ss", args: ["-Htln", "-e"] });
  expect(calls[3]).toEqual({
    file: "/usr/bin/systemd-run",
    args: [
      "--quiet",
      "--scope",
      "--collect",
      "--slice=agents-21000.slice",
      "--",
      "/usr/sbin/runuser",
      "-u",
      "ag-a1b2c3d4",
      "--",
      ...runner,
      "bind-check",
      "10001",
      "12000",
      "12001",
      "3001",
    ],
  });
  expect(calls[4]).toEqual({ file: "ss", args: ["-Htln", "-e"] });
});

test("an occupied own browser port is skipped in the allowed-port probe", () => {
  const calls: string[][] = [];
  const run: RunCommand = (file, args) => {
    calls.push([file, ...args]);
    return { code: 0, output: file === "ss" ? "LISTEN 0 0 127.0.0.1:12000 0.0.0.0:* uid:21000" : "" };
  };
  ensureBrowserBindPolicy(user, runner, { run, systemd: true });
  expect(calls.at(-2)?.slice(-4)).toEqual(["10000", "0", "12001", "3000"]);
});

test("systemd, slice, property, listing, and kernel probe failures all refuse worker launch", () => {
  for (const failed of ["start", "set-property", "ss", "/usr/bin/systemd-run"]) {
    const run: RunCommand = (file, args) => ({
      code: file === failed || args[0] === failed ? 1 : 0,
      output: file === failed || args[0] === failed ? "denied" : "",
    });
    expect(() => ensureBrowserBindPolicy(user, runner, { run, systemd: true })).toThrow();
  }
  expect(() => ensureBrowserBindPolicy(user, runner, { systemd: false })).toThrow("require systemd");
});

test("a reserved browser port held by another UID fails before or after the kernel probe", () => {
  for (const onScan of [1, 2]) {
    let scans = 0;
    const run: RunCommand = (file) => {
      if (file !== "ss") return { code: 0, output: "" };
      scans++;
      return {
        code: 0,
        output: scans === onScan ? "LISTEN 0 0 127.0.0.1:12000 0.0.0.0:* uid:21001 ino:1 sk:0" : "",
      };
    };
    expect(() => ensureBrowserBindPolicy(user, runner, { run, systemd: true })).toThrow("wrong listener owner");
  }
});

test.if(process.platform !== "win32")(
  "network diagnostics and the kernel bind check enter the worker's configured namespace",
  () => {
    const calls: { file: string; args: string[] }[] = [];
    const hook = "/usr/bin/true"; // A root-owned executable; the fake records it without executing it.
    const run: RunCommand = (file, args) => {
      calls.push({ file, args });
      return { code: 0, output: "" };
    };
    ensureBrowserBindPolicy({ ...user, networkLauncher: hook }, runner, { run, systemd: true });
    const look = calls.filter((c) => c.file === hook);
    expect(look).toHaveLength(2);
    expect(look[0]?.args).toEqual(["21000", "--", "/usr/bin/ss", "-Htln", "-e"]);
    const check = calls.find((c) => c.file === "/usr/bin/systemd-run");
    expect(check?.args.slice(5, 11)).toEqual([hook, "21000", "--", "/usr/sbin/runuser", "-u", user.user]);
  },
);
