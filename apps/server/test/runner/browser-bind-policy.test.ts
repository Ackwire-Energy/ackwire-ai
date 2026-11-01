import { expect, test } from "bun:test";
import { systemLauncher } from "../../runner/agent-users";
import {
  type BindPolicyOptions,
  conflictingBrowserPorts,
  ensureBrowserBindPolicy,
} from "../../runner/browser-bind-policy";
import type { RunCommand } from "../../runner/service";

const user = { id: "agent-1", user: "ag-a1b2c3d4", uid: 20001 };
const runner = ["/usr/bin/bun", "/opt/agentes/runner.ts"];
const TMP = "2049:131073";

/** The computer around the policy: what ran, in order, with the probe answering as a kernel that holds. */
function computer(o: { ss?: (scan: number) => string; fail?: string; probe?: string; tmp?: string | null } = {}) {
  const calls: { file: string; args: string[] }[] = [];
  const order: string[] = [];
  let scans = 0;
  const run: RunCommand = (file, args) => {
    calls.push({ file, args });
    order.push(file === "systemctl" ? `systemctl ${args[0]}` : file);
    if (file === o.fail || args[0] === o.fail) return { code: 1, output: "denied" };
    if (file === "ss") return { code: 0, output: o.ss?.(++scans) ?? "" };
    if (file === "/usr/bin/systemd-run") return { code: 0, output: o.probe ?? `tmp ${TMP}` };
    return { code: 0, output: "" };
  };
  const decoys = { opened: 0, closed: 0 };
  const opts: BindPolicyOptions = {
    uidRange: [20000, 20999],
    run,
    systemd: true,
    refresh: () => order.push("refresh"),
    ephemeralRange: () => "32768 60999",
    decoys: () => {
      decoys.opened++;
      order.push("decoys");
      return { ports: [41000, 41001], close: () => decoys.closed++ };
    },
    folderId: (dir) => (dir === "/var/lib/agentes-runner-tmp/20001/tmp" ? (o.tmp === undefined ? TMP : o.tmp) : null),
  };
  return { run, calls, order, decoys, opts };
}

test("the slice, the guard's map, a band-only deny, then the probe as every agent process starts", () => {
  const pc = computer({
    ss: () =>
      "LISTEN 0 0 127.0.0.1:10000 0.0.0.0:* uid:20000 ino:1 sk:0\n" +
      "LISTEN 0 0 127.0.0.1:3000 0.0.0.0:* uid:20005 ino:2 sk:0",
  });
  ensureBrowserBindPolicy(user, runner, pc.opts);
  expect(pc.order).toEqual([
    "systemctl start",
    "refresh",
    "systemctl set-property",
    "ss",
    "decoys",
    "/usr/bin/systemd-run",
    "ss",
  ]);
  expect(pc.calls[0]).toEqual({ file: "systemctl", args: ["start", "agents-20001.slice"] });
  // Only the band (the browser pairs of 20000-20999), its own pair excepted: bind(0) matches no rule with ports.
  expect(pc.calls[1]).toEqual({
    file: "systemctl",
    args: [
      "set-property",
      "--runtime",
      "agents-20001.slice",
      "SocketBindAllow=",
      "SocketBindAllow=tcp:10002-10003",
      "SocketBindDeny=",
      "SocketBindDeny=tcp:10000-11999",
    ],
  });
  const [launch, ...prefix] = systemLauncher(user, true).prefix;
  expect(pc.calls[3]).toEqual({
    file: launch as string,
    // Another agent's free pair port, its own pair, a free dev port, the band, root's two decoys.
    args: [...prefix, ...runner, "bind-check", "10001", "10002", "10003", "3001", "10000-11999", "41000", "41001"],
  });
  expect(pc.decoys).toEqual({ opened: 1, closed: 1 });
});

test("the default range: the whole of 10000-29999 is the band", () => {
  const pc = computer();
  ensureBrowserBindPolicy(user, runner, { ...pc.opts, uidRange: [20000, 29999] });
  expect(pc.calls[1]?.args.at(-1)).toBe("SocketBindDeny=tcp:10000-29999");
  expect(pc.calls[3]?.args.slice(-3)).toEqual(["10000-29999", "41000", "41001"]);
});

test("its own port a browser already holds is skipped in the probe", () => {
  const pc = computer({ ss: () => "LISTEN 0 0 127.0.0.1:10002 0.0.0.0:* uid:20001" });
  ensureBrowserBindPolicy(user, runner, pc.opts);
  expect(pc.calls[3]?.args.slice(-7)).toEqual(["10000", "0", "10003", "3000", "10000-11999", "41000", "41001"]);
});

test("every failure refuses the launch, and root's decoys always close", () => {
  for (const fail of ["start", "set-property", "ss", "/usr/bin/systemd-run"]) {
    const pc = computer({ fail });
    expect(() => ensureBrowserBindPolicy(user, runner, pc.opts)).toThrow();
    expect(pc.decoys.opened).toBe(pc.decoys.closed);
  }
  expect(() => ensureBrowserBindPolicy(user, runner, { ...computer().opts, systemd: false })).toThrow(
    "require systemd",
  );
  // bind(0) could land in the band: an ephemeral range read again at each start.
  expect(() =>
    ensureBrowserBindPolicy(user, runner, { ...computer().opts, ephemeralRange: () => "11000 60999" }),
  ).toThrow("overlaps reserved browser ports 10000-11999");
});

test("the probe's /tmp must be the agent's own folder", () => {
  for (const [probe, tmp, why] of [
    ["tmp 2049:2", TMP, "Agent 20001's /tmp isn't its own (2049:2, its folder 2049:131073)"],
    ["", TMP, "Agent 20001's /tmp isn't its own (not said, its folder 2049:131073)"],
    [`tmp ${TMP}`, null, `Agent 20001's /tmp isn't its own (${TMP}, its folder missing)`],
  ] as const) {
    expect(() => ensureBrowserBindPolicy(user, runner, computer({ probe, tmp }).opts)).toThrow(why);
  }
});

test("a reserved browser port held by another uid fails before or after the kernel probe", () => {
  for (const onScan of [1, 2]) {
    const pc = computer({
      ss: (scan) => (scan === onScan ? "LISTEN 0 0 127.0.0.1:10002 0.0.0.0:* uid:20005 ino:1 sk:0" : ""),
    });
    expect(() => ensureBrowserBindPolicy(user, runner, pc.opts)).toThrow("wrong listener owner");
  }
});

test("a listener on a browser port must be its owner's: only that agent's pair is looked at", () => {
  const ss = [
    "LISTEN 0 0 127.0.0.1:10002 0.0.0.0:* uid:20001",
    "LISTEN 0 0 [::1]:10003 [::]:* uid:20004",
    "LISTEN 0 0 127.0.0.1:10004 0.0.0.0:* uid:20001",
    "ESTAB 0 0 127.0.0.1:10003 127.0.0.1:5000 uid:20004",
  ].join("\n");
  expect(conflictingBrowserPorts(ss, [20001, 20001])).toEqual([10003]);
  expect(conflictingBrowserPorts(ss, [20000, 20999])).toEqual([10003, 10004]);
});
