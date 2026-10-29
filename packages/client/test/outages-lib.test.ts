import { describe, expect, test } from "bun:test";
import type { OutageTarget } from "../src/api/types";
import { brainUnavailableOf, isOfflineNotice, outageKey, targetBlock, targetsFor } from "../src/lib/outages";

describe("offline computers", () => {
  test("a target takes the agents only when it runs their brains", () => {
    const mac: OutageTarget = {
      kind: "machine",
      machineId: "m",
      name: "Mac",
      platform: "darwin",
      online: true,
      brains: ["claude_code"],
      reasonOff: null,
    };
    expect(targetBlock(mac, ["claude_code"])).toBeNull();
    expect(targetBlock(mac, ["codex"])).toBe("noBrain");
    expect(targetBlock({ ...mac, online: false, reasonOff: "offline" }, ["claude_code"])).toBe("offline");
    expect(targetBlock({ ...mac, reasonOff: "paused" }, ["claude_code"])).toBe("reason");
    expect(targetBlock({ kind: "cloud", available: true, brains: [] }, ["claude_code"])).toBe("noBrain");
    expect(targetBlock({ kind: "cloud", available: false, brains: [] }, ["claude_code"])).toBe("unavailable");
  });

  test("the targets: not the offline computer, the cloud one only when it can run one of the agents' brains", () => {
    const mac: OutageTarget = {
      kind: "machine",
      machineId: "m",
      name: "Mac",
      platform: "darwin",
      online: true,
      brains: ["claude_code"],
      reasonOff: null,
    };
    const off: OutageTarget = { ...mac, machineId: "off", online: false };
    const data = (cloud: OutageTarget) => ({ outages: [], targets: [mac, off, cloud] });
    type Cloud = Extract<OutageTarget, { kind: "cloud" }>;
    const none: Cloud = { kind: "cloud", available: true, brains: [] };
    // What every server sends today (no brain on it): no row, as on the phone.
    expect(targetsFor(data(none), "off", ["claude_code"])).toEqual([mac]);
    expect(targetsFor(data({ ...none, brains: ["codex"] }), "off", ["claude_code"])).toEqual([mac]);
    const able: Cloud = { ...none, brains: ["claude_code"] };
    expect(targetsFor(data({ ...able, available: false }), "off", ["claude_code"])).toEqual([mac]);
    expect(targetsFor(data(able), "off", ["claude_code", "codex"])).toEqual([mac, able]);
    expect(targetsFor(undefined, "off", ["claude_code"])).toEqual([]);
  });

  test("the notice in a message's meta", () => {
    expect(brainUnavailableOf({ bodyCode: "done" })).toBeNull();
    const n = brainUnavailableOf({
      bodyCode: "brain_unavailable",
      brainUnavailable: { brain: "codex", code: "machine_offline", machineId: "m" },
    });
    expect(n).toEqual({ brain: "codex", code: "machine_offline", machineId: "m", agentId: null, resetsAt: null });
    expect(n && isOfflineNotice(n)).toBe(true);
    expect(isOfflineNotice({ ...(n as NonNullable<typeof n>), code: "machine_paused" })).toBe(false);
    expect(outageKey({ machineId: "m", offlineSince: "t" })).toBe("m@t");
  });
});
