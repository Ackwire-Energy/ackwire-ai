import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { OutageTarget } from "../src/api/types";
import { serverBody } from "../src/lib/message-body";
import { brainUnavailableOf, isOfflineNotice, outageKey, targetBlock } from "../src/lib/outages";

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

  test("a note waiting for room on a busy computer has its own words, never a card about it coming back", () => {
    const t = ((key: string) => key) as unknown as TFunction;
    const note = (code: string) => ({
      bodyCode: "brain_unavailable",
      brainUnavailable: { brain: "claude_code", code },
    });
    expect(serverBody(t, "…", note("busy"))).toBe("chat.body.brain_busy");
    expect(serverBody(t, "…", note("machine_offline"))).toBe("chat.body.brain_unavailable");
    const busy = brainUnavailableOf(note("busy"));
    expect(busy && isOfflineNotice(busy)).toBe(false);
  });
});
