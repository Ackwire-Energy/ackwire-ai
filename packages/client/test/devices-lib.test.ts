import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { ComputerDevice, DeviceAudience, PhoneDevice } from "../src/api/types";
import {
  androidStage,
  audienceWords,
  deviceCounts,
  deviceNoticeOf,
  deviceRows,
  deviceWaitEventOf,
  deviceWaitOf,
  iphoneSteps,
  linkPhase,
  narrowsAudience,
  statusDetail,
  statusPill,
  waitEndedText,
  waitText,
} from "../src/lib/devices";

const i18n = i18next.createInstance();
void i18n.init({ lng: "en", fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
const t = i18n.t as TFunction;
const NOW = new Date("2026-11-09T14:20:00");
const at = (h: number, m: number) => new Date(2026, 10, 9, h, m).toISOString();
const everyone: DeviceAudience = { mode: "everyone", userIds: [], roleIds: [] };
const owner: DeviceAudience = { mode: "owner", userIds: [], roleIds: [] };
const people = (userIds: string[], roleIds: string[] = []): DeviceAudience => ({ mode: "people", userIds, roleIds });

const phone = (p: Partial<PhoneDevice>): PhoneDevice => ({
  id: "p",
  platform: "android",
  phoneKind: "device",
  name: "Pixel 8",
  model: "Pixel 8",
  osVersion: "16",
  hostMachineId: "m",
  ownerUserId: "u-sam",
  audience: everyone,
  status: { kind: "ready" },
  transport: "usb",
  lastSeenAt: null,
  mayUse: true,
  mayManage: true,
  ...p,
});
const computer = (c: Partial<ComputerDevice>): ComputerDevice => ({
  id: "m",
  machineKind: "connected",
  name: "Sam's MacBook Pro",
  os: "darwin",
  arch: "arm64",
  hostname: "sams-mbp",
  cpus: 12,
  memoryGb: 36,
  ownerUserId: "u-sam",
  belongsToWorkspace: false,
  systemMode: false,
  audience: owner,
  status: { kind: "ready" },
  maxTasks: 1,
  toolchains: {},
  lastSeenAt: null,
  mayUse: true,
  mayManage: true,
  phones: [],
  ...c,
});

describe("status words", () => {
  test("the pill says the state, the detail the rest", () => {
    const inUse = {
      kind: "in_use",
      agentId: "a",
      agentName: "Lia",
      userId: "u-rui",
      userName: "Rui Tanaka",
      since: at(14, 10),
    } as const;
    expect(statusPill(t, inUse)).toBe("In use by Lia");
    expect(statusDetail(t, "en-US", inUse, { now: NOW })).toBe("for Rui since 2:10 PM");
    expect(statusPill(t, { kind: "busy", running: 1, max: 1 })).toBe("Busy 1/1");
    expect(statusDetail(t, "en-US", { kind: "needs_you", reason: "developer_mode_off" })).toBe(
      "Turn on Developer Mode",
    );
    expect(statusDetail(t, "en-US", { kind: "needs_you", reason: "something_new" })).toBe("See what it needs");
    expect(statusDetail(t, "en-US", { kind: "offline", lastSeenAt: at(14, 2) }, { now: NOW })).toBe(
      "last seen 2:02 PM",
    );
    expect(
      statusDetail(t, "en-US", { kind: "offline", lastSeenAt: null, withHost: true }, { host: "Ana's iMac" }),
    ).toBe("with Ana's iMac");
    expect(statusDetail(t, "en-US", { kind: "ready" })).toBeNull();
  });
});

describe("who can use it", () => {
  test("in words, a phone shared wider than its computer says so", () => {
    const host = { name: "Sam's MacBook Pro", audience: owner };
    expect(audienceWords(t, { audience: owner, ownerName: "Sam Rivera" }).text).toBe("Only Sam");
    expect(audienceWords(t, { audience: everyone, ownerName: "Sam Rivera", host }).text).toBe("Everyone, phone only");
    expect(audienceWords(t, { audience: null, ownerName: "Sam Rivera", host }).text).toBe("Same as Sam's MacBook Pro");
    expect(audienceWords(t, { audience: people(["a", "b"], ["r"]), ownerName: "Sam" }).text).toBe("2 people, 1 role");
    // A workspace device nobody owns under "only the owner" is everyone's.
    expect(audienceWords(t, { audience: owner, ownerName: null, belongsToWorkspace: true }).text).toBe("Everyone");
  });

  test("an admin only narrows", () => {
    expect(narrowsAudience(everyone, people(["a"]))).toBe(true);
    expect(narrowsAudience(people(["a", "b"]), people(["a"]))).toBe(true);
    expect(narrowsAudience(people(["a"]), people(["a", "b"]))).toBe(false);
    expect(narrowsAudience(people(["a"]), everyone)).toBe(false);
    expect(narrowsAudience(owner, people(["a"]))).toBe(false);
    expect(narrowsAudience(people(["a"]), owner)).toBe(true);
  });
});

describe("the list", () => {
  const list = [
    computer({ id: "m", phones: [phone({ id: "p1" }), phone({ id: "p2", name: "iPhone 16", platform: "ios" })] }),
    computer({ id: "w", machineKind: "managed", name: "Workspace computer", os: "linux" }),
    computer({ id: "b", name: "build-box", os: "linux" }),
  ];
  test("the workspace computer first, phones under their host", () => {
    expect(deviceRows(list, "all").map((r) => r.device.id)).toEqual(["w", "m", "p1", "p2", "b"]);
    expect(deviceRows(list, "computers").map((r) => r.device.id)).toEqual(["w", "m", "b"]);
    expect(deviceRows(list, "phones").map((r) => [r.device.id, r.kind === "phone" && r.nested])).toEqual([
      ["p1", false],
      ["p2", false],
    ]);
    expect(deviceCounts(list)).toEqual({ all: 5, computers: 3, phones: 2 });
  });
  test("a search keeps a matching phone under its host", () => {
    expect(deviceRows(list, "all", "iphone").map((r) => r.device.id)).toEqual(["m", "p2"]);
    expect(deviceRows(list, "all", "BUILD").map((r) => r.device.id)).toEqual(["b"]);
  });
});

describe("connect links", () => {
  test("a link nobody used expires on the clock, even before the server says", () => {
    const expiresAt = new Date(NOW.getTime() + 60_000).toISOString();
    expect(linkPhase(undefined, expiresAt, NOW.getTime())).toBe("waiting");
    expect(linkPhase({ status: "waiting" }, expiresAt, NOW.getTime() + 61_000)).toBe("expired");
    // A computer already asking keeps asking past the link's own time.
    expect(linkPhase({ status: "asking" }, expiresAt, NOW.getTime() + 61_000)).toBe("asking");
  });
});

describe("connecting a phone", () => {
  test("Android: looking, then Allow, then ready; a phone already there doesn't count", () => {
    const host = computer({ phones: [phone({ id: "old" })] });
    const known = new Set(["old"]);
    expect(androidStage(host, known).kind).toBe("looking");
    host.phones.push(phone({ id: "new", status: { kind: "needs_you", reason: "unauthorized" } }));
    expect(androidStage(host, known)).toMatchObject({ kind: "allow", phone: { id: "new" } });
    host.phones[1] = phone({ id: "new" });
    expect(androidStage(host, known)).toMatchObject({ kind: "ready", phone: { id: "new" } });
  });

  test("iPhone: steps before the phone's reason are done, that one waits on the person", () => {
    const mac = computer({ toolchains: { xcode: "27.0", appleTeam: "Sam Rivera (Personal Team)" } });
    expect(iphoneSteps(mac, null)).toMatchObject({
      xcode: "done",
      tools: "done",
      account: "done",
      connected: "current",
    });
    expect(iphoneSteps(computer({}), null).xcode).toBe("needs");
    // No Apple Account in Xcode yet: that's the person's step.
    expect(iphoneSteps(computer({ toolchains: { xcode: "27.0" } }), null)).toMatchObject({
      account: "needs",
      connected: "waiting",
    });
    const iphone = phone({ platform: "ios", status: { kind: "needs_you", reason: "developer_mode_off" } });
    expect(Object.values(iphoneSteps(mac, iphone))).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "needs",
      "waiting",
      "waiting",
    ]);
    expect(Object.values(iphoneSteps(mac, phone({ platform: "ios" }))).every((s) => s === "done")).toBe(true);
    // The Mac builds the test helper by itself; trusting it on the iPhone is the person's.
    const at = (status: PhoneDevice["status"]) => iphoneSteps(mac, phone({ platform: "ios", status }));
    expect(at({ kind: "preparing", reason: "helper_missing" }).helper).toBe("current");
    // Its build failed: the person sees it.
    expect(at({ kind: "needs_you", reason: "helper_missing" }).helper).toBe("needs");
    expect(at({ kind: "needs_you", reason: "helper_untrusted" }).helper).toBe("needs");
    expect(at({ kind: "needs_you", reason: "team_limit" }).helper).toBe("needs");
    // Plugged in, trusted and in Developer Mode before the Mac looks for the account.
    expect(at({ kind: "needs_you", reason: "apple_account_missing" })).toMatchObject({
      account: "needs",
      connected: "done",
      developerMode: "done",
      uiAutomation: "waiting",
    });
  });
});

describe("in the chat and the inbox", () => {
  test("a device wait: live while waiting, then one line saying how it ended", () => {
    const meta = {
      deviceWait: {
        runId: "run-1",
        device: {
          kind: "phone",
          id: "p1",
          name: "Pixel 8",
          platform: "android",
          hostId: "m",
          hostName: "Sam's MacBook Pro",
        },
        deviceName: "Pixel 8",
        hostName: "Sam's MacBook Pro",
        reason: "offline",
        detail: null,
        lastSeenAt: at(14, 2),
        state: "waiting",
      },
    };
    const w = deviceWaitOf(meta);
    expect(w).toMatchObject({
      deviceName: "Pixel 8",
      deviceId: "p1",
      kind: "phone",
      platform: "android",
      state: "waiting",
    });
    if (!w) throw new Error("parsed");
    expect(waitText(t, "en-US", w, { now: NOW })).toBe(
      "Sam's MacBook Pro is offline (last seen 2:02 PM), so I can't reach Pixel 8 on it. I'll start when it's back.",
    );
    expect(waitText(t, "en-US", { ...w, reason: "asked" }, { owner: "Sam Rivera" })).toBe(
      "I've asked Sam to let me use Pixel 8.",
    );
    expect(waitText(t, "en-US", { ...w, reason: "needs_you", detail: "developer_mode_off" })).toBe(
      "Pixel 8 can't take work yet. Developer Mode is off. I'll start when it can.",
    );
    expect(waitEndedText(t, { ...w, state: "back" })).toBe("Pixel 8 is back");
    expect(waitEndedText(t, { ...w, state: "denied" }, "Sam Rivera")).toBe("Sam said no to Pixel 8");
    expect(deviceWaitOf({ deviceWait: { state: "waiting" } })).toBeNull();
    expect(
      deviceWaitEventOf({ type: "device_wait.updated", channelId: "c", messageId: "m", deviceWait: {} } as never),
    ).toEqual({
      channelId: "c",
      threadId: null,
      messageId: "m",
      deviceWait: {},
    });
  });

  test("a device notice's parts", () => {
    const n = {
      kind: "device.access_request",
      actors: [{ type: "agent", id: "a-lia" }],
      source: { requestId: "ar1", phoneId: "p1", label: "iPhone 16", userId: "u-rui", runId: "run-1" },
      latest: { title: "Rui", text: "Record the checkout" },
    } as never;
    expect(deviceNoticeOf(n)).toMatchObject({
      kind: "device.access_request",
      requestId: "ar1",
      device: "iPhone 16",
      agentId: "a-lia",
      forName: "Rui",
    });
    expect(deviceNoticeOf({ kind: "mention", source: {}, latest: {} } as never)).toBeNull();
  });
});
