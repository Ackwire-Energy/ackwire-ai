import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunnerPhone } from "@agenteschat/adapters/machine-protocol";
import {
  adbStateOf,
  androidKind,
  androidTransport,
  keyguardShowing,
  parseAdbDevices,
  parseAndroidFacts,
  pngFrom,
  pngSize,
  serverStatusPath,
} from "../../runner/adb";
import { appleNeedsYou, parseDevicectl, parseSimctl } from "../../runner/apple-devices";
import type { RunnerError } from "../../runner/errors";
import { type HandlerContext, handleRequest, OP_ROUTES, type RequestScope } from "../../runner/handlers";
import { acquireLock } from "../../runner/lock";
import {
  androidText,
  applyInput,
  NO_IOS_CONTROL,
  type PhoneIo,
  PhoneManager,
  type PhoneRequest,
  type PhoneScreenDriver,
  registerIosScreenDriver,
  SimulatorScreen,
  screenDriverFor,
} from "../../runner/phones";
import type { DataListener, DataSocket, DataSockets } from "../../runner/streams";
import { IosHelper, WDA_VERSION } from "../../runner/wda";
import { fakeUsbmuxd, freePort } from "./fake-usbmuxd";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const FAKE = path.join(import.meta.dir, "fake-phone-tools.mjs");
const TOOLS = ["adb", "xcrun", "xcode-select", "maestro", "scrcpy", "bundletool", "plutil", "idevicesyslog", "ffmpeg"];

const PIXEL = "38021FDH2000AB";
const EMU = "emulator-5554";
const SIM = "5C5C62E5-74E2-4E25-93AD-65E264BE78A4";
const IPHONE = "00008110-001475263AC0A01E";

const PIXEL_FACTS = `model=Pixel 8
market=
release=16
sdk=36
abi=arm64-v8a
boot=1
qemu=
qemu2=
avd=
name=Sam's Pixel
Physical size: 1080x2400
Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Dock powered: false
  status: 2
  level: 87
`;
const EMU_FACTS = `model=sdk_gphone64_arm64
release=15
sdk=35
abi=arm64-v8a
boot=1
qemu=1
avd=Pixel_8_API_35
name=null
Physical size: 1080x2400
`;

const SIMCTL = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
      {
        udid: SIM,
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        state: "Booted",
        name: "iPhone 17 Pro",
      },
      {
        udid: "D54B1757-01C6-48BB-87F2-E6109AECE89A",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max",
        state: "Shutdown",
        name: "iPhone 17 Pro Max",
      },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [
      { udid: "W1", deviceTypeIdentifier: "x.SimDeviceType.Apple-Watch", state: "Booted", name: "Watch" },
    ],
  },
};

/** A real iPhone as devicectl lists it (Xcode 26.3), reachable over `transport` or not at all. */
const iphone = (over: { transport?: string; pairing?: string; devMode?: string; udid?: string } = {}) => ({
  connectionProperties: {
    pairingState: over.pairing ?? "paired",
    tunnelState: over.transport ? "disconnected" : "unavailable",
    ...(over.transport ? { transportType: over.transport } : {}),
  },
  deviceProperties: {
    developerModeStatus: over.devMode ?? "enabled",
    name: "Ana's iPhone",
    osVersionNumber: "27.0",
  },
  hardwareProperties: {
    marketingName: "iPhone 14",
    platform: "iOS",
    productType: "iPhone14,7",
    reality: "physical",
    udid: over.udid ?? IPHONE,
  },
  identifier: "F231DD07-C736-5329-B5FE-287E4F2B2A5C",
});

test("adb devices -l: serials, states, models, kinds and transports", () => {
  const listed = parseAdbDevices(`List of devices attached
* daemon started successfully
${PIXEL}         device usb:1-1 product:shiba model:Pixel_8 device:shiba transport_id:3
R5CT1234567      unauthorized usb:1-2 transport_id:4
emulator-5554    device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
192.168.1.20:5555 offline transport_id:5
adb-38021FDH-AbCd._adb-tls-connect._tcp device product:shiba model:Pixel_8 device:shiba transport_id:6
0123456789ABCDEF no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-3 transport_id:7

`);
  expect(listed).toEqual([
    { serial: PIXEL, state: "device", model: "Pixel 8" },
    { serial: "R5CT1234567", state: "unauthorized" },
    { serial: EMU, state: "device", model: "sdk gphone64 arm64" },
    { serial: "192.168.1.20:5555", state: "offline" },
    { serial: "adb-38021FDH-AbCd._adb-tls-connect._tcp", state: "device", model: "Pixel 8" },
    { serial: "0123456789ABCDEF", state: "no permissions" },
  ]);
  expect(listed.map((e) => [androidKind(e.serial), androidTransport(e.serial)])).toEqual([
    ["device", "usb"],
    ["device", "usb"],
    ["emulator", "local"],
    ["device", "wifi"],
    ["device", "wifi"],
    ["device", "usb"],
  ]);
  expect(listed.map((e) => adbStateOf(e.state))).toEqual([
    { state: "ready" },
    { state: "needs_you", reason: "unauthorized" },
    { state: "ready" },
    { state: "needs_you", reason: "adb_offline" },
    { state: "ready" },
    { state: "needs_you", reason: "no_driver" },
  ]);
  expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
});

test("a phone's facts: model, its own name, screen, power; an emulator by its AVD", () => {
  expect(parseAndroidFacts(PIXEL_FACTS)).toEqual({
    model: "Pixel 8",
    osVersion: "16",
    sdk: 36,
    abi: "arm64-v8a",
    booted: true,
    emulator: false,
    name: "Sam's Pixel",
    screen: { width: 1080, height: 2400 },
    power: "ac",
    battery: 87,
  });
  const emu = parseAndroidFacts(`${EMU_FACTS}Override size: 720x1600\n`);
  expect(emu).toMatchObject({ model: "Pixel 8 API 35", emulator: true, screen: { width: 720, height: 1600 } });
  expect(emu.name).toBeUndefined();
  expect(parseAndroidFacts("boot=\n").booted).toBe(false);
});

test("lock screen markers across Android versions; PNG size", () => {
  expect(keyguardShowing("    mDreamingLockscreen=true mDreamingSleepToken=null")).toBe(true);
  expect(keyguardShowing("    Display:0 KeyguardShowing=true AodShowing=false KeyguardGoingAway=false")).toBe(true);
  expect(keyguardShowing("  KeyguardController:\n    mKeyguardShowing=false\n    mAodShowing=false")).toBe(false);
  expect(keyguardShowing("")).toBe(false);
  const head = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(head);
  head.writeUInt32BE(1080, 16);
  head.writeUInt32BE(2400, 20);
  expect(pngSize(head)).toEqual({ width: 1080, height: 2400 });
  expect(pngSize(Buffer.from("not a png at all, really not"))).toBeNull();
  // A phone with two displays prints a warning before the picture.
  const warned = Buffer.concat([Buffer.from("[Warning] Multiple displays were found\n"), head]);
  expect(pngSize(pngFrom(warned))).toEqual({ width: 1080, height: 2400 });
  expect(pngFrom(head)).toBe(head);
});

test("the running adb server's binary, from its server-status answer", () => {
  // The bytes adb 36.0.2 answered on a Mac (`host:server-status`), after OKAY and the length.
  const adb = "/Users/sam/Library/Android/sdk/platform-tools/adb";
  const str = (field: number, text: string) => [(field << 3) | 2, text.length, ...Buffer.from(text)];
  const msg = Buffer.from([
    0x08,
    0x02,
    0x18,
    0x02,
    ...str(5, "36.0.2"),
    ...str(6, "14143358"),
    ...str(7, adb),
    ...str(8, "/tmp/adb.log"),
  ]);
  expect(serverStatusPath(msg)).toBe(adb);
  expect(serverStatusPath(Buffer.from([0x08, 0x02]))).toBeNull();
});

test("iPhones: only ones plugged in now, with trust and Developer Mode; booted iOS simulators only", () => {
  const devices = parseDevicectl({
    result: {
      devices: [
        iphone({ transport: "wired" }),
        iphone({ udid: "OLD" }),
        iphone({ transport: "localNetwork", udid: "NEARBY" }),
        iphone({ transport: "wired", pairing: "unpaired", udid: "U2" }),
        iphone({ transport: "wired", devMode: "disabled", udid: "U3" }),
        { hardwareProperties: { platform: "watchOS", udid: "W" }, connectionProperties: { transportType: "wired" } },
      ],
    },
  });
  expect(devices).toEqual([
    {
      platform: "ios",
      serial: IPHONE,
      kind: "device",
      model: "iPhone 14",
      name: "Ana's iPhone",
      osVersion: "27.0",
      state: "ready",
      transport: "usb",
    },
    expect.objectContaining({ serial: "U2", state: "needs_you", reason: "untrusted", transport: "usb" }),
    expect.objectContaining({ serial: "U3", state: "needs_you", reason: "developer_mode_off" }),
  ]);
  expect(parseDevicectl({ nothing: true })).toEqual([]);
  expect(parseSimctl(SIMCTL)).toEqual([
    {
      platform: "ios",
      serial: SIM,
      kind: "simulator",
      model: "iPhone 17 Pro",
      osVersion: "26.2",
      state: "ready",
      transport: "local",
    },
  ]);
  expect(
    appleNeedsYou(
      "ERROR: The application could not be launched because its profile has not been explicitly trusted by the user.",
    ),
  ).toContain("VPN & Device Management");
  expect(appleNeedsYou("ERROR: Unable to launch because the device was not, or could not be, unlocked.")).toContain(
    "locked",
  );
  expect(appleNeedsYou("ERROR: something else")).toBeNull();
});

/** A computer with fake phone tools on its PATH, and a manager watching it. */
function rig(
  state: Record<string, unknown>,
  opts: {
    tools?: string[];
    platform?: NodeJS.Platform;
    readOnly?: boolean;
    /** The iPhone test helper (none by default: a real iPhone is ready to the Mac alone). */
    ios?: (env: NodeJS.ProcessEnv, root: string, now: () => number) => IosHelper;
  } = {},
) {
  const root = tempDir("phones-");
  dirs.push(root);
  const bin = path.join(root, "bin");
  const folder = path.join(root, "agent");
  mkdirSync(bin);
  mkdirSync(folder);
  for (const tool of opts.tools ?? TOOLS) {
    writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${tool} "$@"\n`, {
      mode: 0o755,
    });
  }
  const stateFile = path.join(root, "state.json");
  const logFile = path.join(root, "log");
  const setState = (next: Record<string, unknown>) => writeFileSync(stateFile, JSON.stringify(next));
  setState(state);
  const sent: RunnerPhone[][] = [];
  let now = Date.parse("2026-11-09T04:00:00Z");
  const env = { PATH: bin, HOME: root, FAKE_PHONE_STATE: stateFile, FAKE_PHONE_LOG: logFile };
  const manager = new PhoneManager({
    log: () => {},
    onChange: (phones) => sent.push(phones),
    lockDir: path.join(root, "locks"),
    env,
    ios: opts.ios ? opts.ios(env, root, () => now) : null,
    platform: opts.platform ?? "darwin",
    home: root,
    dirs: [],
    adbServer: async () => null,
    now: () => now,
    settleMs: 0,
    caffeinate: false,
    liveLogMs: 2000,
    ...(opts.readOnly ? { readOnly: true } : {}),
  });
  const calls = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as string[])
      : [];
  const io = { folder, resolve: async (p: string) => path.resolve(folder, p), signal: new AbortController().signal };
  const holder = (runId: string, label?: string) => ({
    runId,
    agentId: "agent-lia",
    userId: "user-rui",
    ...(label ? { label } : {}),
    since: "",
  });
  const op = (req: Record<string, unknown>) => manager.handle(req as unknown as PhoneRequest, io);
  return {
    root,
    folder,
    manager,
    sent,
    calls,
    setState,
    op,
    holder,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const ANDROID_STATE = {
  adbDevices: `List of devices attached\n${PIXEL} device usb:1-1 model:Pixel_8\nR5CT1234567 unauthorized usb:1-2\n${EMU} device model:sdk_gphone64_arm64\n`,
  facts: { [PIXEL]: PIXEL_FACTS, [EMU]: EMU_FACTS },
  simctl: SIMCTL,
  devicectl: { result: { devices: [iphone({ transport: "wired" })] } },
};

test("a look lists every phone once, sends the list only when it changed, and turns off the 7-day lapse once", async () => {
  const r = rig(ANDROID_STATE);
  await r.manager.poll();
  const list = r.manager.list();
  expect(list.map((p) => [p.platform, p.serial, p.kind, p.state, p.reason ?? null])).toEqual([
    ["android", PIXEL, "device", "ready", null],
    ["android", "R5CT1234567", "device", "needs_you", "unauthorized"],
    ["android", EMU, "emulator", "ready", null],
    ["ios", IPHONE, "device", "ready", null],
    ["ios", SIM, "simulator", "ready", null],
  ]);
  expect(list[0]).toMatchObject({ model: "Pixel 8", name: "Sam's Pixel", battery: 87, power: "ac", osVersion: "16" });
  expect(list[2]).toMatchObject({ model: "Pixel 8 API 35", transport: "local" });
  expect(r.sent).toHaveLength(1);
  await r.manager.poll();
  await r.manager.poll();
  expect(r.sent).toHaveLength(1);
  const lapse = r.calls().filter((c) => c.join(" ").includes("adb_allowed_connection_time 0"));
  // The real phone only, once.
  expect(lapse).toEqual([["adb", "-s", PIXEL, "shell", "settings put global adb_allowed_connection_time 0"]]);
  // Unplugged: gone from the list, which goes out again.
  r.setState({ ...ANDROID_STATE, adbDevices: "List of devices attached\n" });
  await r.manager.poll();
  await r.manager.poll();
  expect(r.manager.list().map((p) => p.serial)).toEqual([IPHONE, SIM]);
  expect(r.sent).toHaveLength(2);
});

test("a Mac without the developer tools is never asked through xcrun", async () => {
  const r = rig(ANDROID_STATE, { tools: ["adb", "xcrun"] });
  await r.manager.poll();
  expect(r.manager.list().every((p) => p.platform === "android")).toBe(true);
  expect(r.calls().some((c) => c[0] === "xcrun")).toBe(false);
});

test("the lock: one holder, renewed by its calls, released by its run, by force, when idle or when the phone goes", async () => {
  const r = rig(ANDROID_STATE);
  const target = { platform: "android", serial: PIXEL };
  const claimed = (await r.op({
    op: "phone.claim",
    ...target,
    holder: r.holder("run-1", "Recording a test video"),
  })) as {
    holder: { runId: string; since: string };
  };
  expect(claimed.holder).toMatchObject({ runId: "run-1", agentId: "agent-lia", userId: "user-rui" });
  expect(claimed.holder.since).toBe("2026-11-09T04:00:00.000Z");
  expect(r.manager.list()[0]?.holder).toMatchObject({ runId: "run-1", label: "Recording a test video" });
  expect(r.sent.at(-1)?.[0]?.holder?.runId).toBe("run-1");
  // The session keeps the screen on; the person's own setting comes back after.
  expect(r.calls()).toContainEqual(["adb", "-s", PIXEL, "shell", "svc power stayon usb"]);

  expect(await errorCode(() => r.op({ op: "phone.screenshot", ...target, holder: r.holder("run-2") }))).toBe(
    "phone_busy",
  );
  const shot = (await r.op({ op: "phone.screenshot", ...target, holder: r.holder("run-1") })) as {
    path: string;
    width: number;
  };
  expect(shot).toMatchObject({ width: 1080, height: 2400 });
  expect(shot.path).toMatch(/^\.agentes\/phone\/20261109-040000000-screenshot\.png$/);
  expect(existsSync(path.join(r.folder, shot.path))).toBe(true);

  expect(await r.op({ op: "phone.release", ...target, holder: r.holder("run-2") })).toEqual({ released: false });
  expect(await r.op({ op: "phone.release", ...target, holder: r.holder("run-1") })).toEqual({ released: true });
  expect(r.calls()).toContainEqual(["adb", "-s", PIXEL, "shell", "settings put global stay_on_while_plugged_in 0"]);
  expect(r.manager.list()[0]?.holder).toBeUndefined();

  // Stop: anyone's lock, by force.
  await r.op({ op: "phone.claim", ...target, holder: r.holder("run-3") });
  expect(await r.op({ op: "phone.release", ...target, holder: r.holder("run-9"), force: true })).toEqual({
    released: true,
  });

  // Idle for 5 minutes: let go on the next look; a call in between renews it.
  await r.op({ op: "phone.claim", ...target, holder: r.holder("run-4") });
  r.tick(4 * 60_000);
  await r.op({ op: "phone.claim", ...target, holder: r.holder("run-4") });
  r.tick(4 * 60_000);
  await r.manager.poll();
  expect(r.manager.list()[0]?.holder?.runId).toBe("run-4");
  r.tick(60_000);
  await r.manager.poll();
  expect(r.manager.list()[0]?.holder).toBeUndefined();

  // Unplugged while held: the lock goes with it.
  await r.op({ op: "phone.claim", ...target, holder: r.holder("run-5") });
  r.setState({ ...ANDROID_STATE, adbDevices: "List of devices attached\n" });
  await r.manager.poll();
  expect(existsSync(path.join(r.root, "locks", `android_${PIXEL}.lock`))).toBe(false);
});

test("another runner of this user driving the phone: busy", async () => {
  const r = rig(ANDROID_STATE);
  mkdirSync(path.join(r.root, "locks"));
  // A live process that isn't this one (the test runner's parent) holds the phone's claim.
  writeFileSync(
    path.join(r.root, "locks", `android_${PIXEL}.lock`),
    JSON.stringify({ pid: process.ppid, mode: "phone", startedAt: new Date().toISOString() }),
  );
  expect(
    await errorCode(() => r.op({ op: "phone.claim", platform: "android", serial: PIXEL, holder: r.holder("run-1") })),
  ).toBe("phone_busy");
});

test("phones not there or not ready say so; nothing reaches a shell but an app id", async () => {
  const r = rig(ANDROID_STATE);
  const h = r.holder("run-1");
  expect(await errorCode(() => r.op({ op: "phone.claim", platform: "android", serial: "GONE", holder: h }))).toBe(
    "phone_missing",
  );
  expect(
    await errorCode(() => r.op({ op: "phone.claim", platform: "android", serial: "R5CT1234567", holder: h })),
  ).toBe("phone_not_ready");
  expect(await errorCode(() => r.op({ op: "phone.claim", platform: "windows", serial: PIXEL, holder: h }))).toBe(
    "bad_request",
  );
  expect(
    await errorCode(() =>
      r.op({ op: "phone.launch", platform: "android", serial: PIXEL, holder: h, app: "com.acme.app; reboot" }),
    ),
  ).toBe("bad_request");
  expect(r.calls().some((c) => c.join(" ").includes("reboot"))).toBe(false);
});

test("Android ops: install, launch, logs, and what each runs", async () => {
  const r = rig(ANDROID_STATE);
  const t = { platform: "android", serial: PIXEL, holder: r.holder("run-1") };
  writeFileSync(path.join(r.folder, "app-debug.apk"), "APK");
  expect(await r.op({ op: "phone.install", ...t, path: "app-debug.apk" })).toEqual({
    output: "Performing Streamed Install\nSuccess",
  });
  expect(r.calls()).toContainEqual(["adb", "-s", PIXEL, "install", "-r", "-t", path.join(r.folder, "app-debug.apk")]);
  expect(await errorCode(() => r.op({ op: "phone.install", ...t, path: "notes.txt" }))).toBe("bad_request");

  r.setState({
    ...ANDROID_STATE,
    installFail: "adb: failed to install x.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n",
  });
  const failed = await r.op({ op: "phone.install", ...t, path: "app-debug.apk" }).catch((e: Error) => e.message);
  expect(failed).toContain("INSTALL_FAILED_UPDATE_INCOMPATIBLE");
  r.setState(ANDROID_STATE);

  await r.op({ op: "phone.launch", ...t, app: "com.acme.app" });
  expect(r.calls()).toContainEqual([
    "adb",
    "-s",
    PIXEL,
    "shell",
    "monkey -p com.acme.app -c android.intent.category.LAUNCHER 1",
  ]);
  await r.op({ op: "phone.launch", ...t, app: "com.acme.app/.MainActivity" });
  expect(r.calls()).toContainEqual(["adb", "-s", PIXEL, "shell", "am start -n com.acme.app/.MainActivity"]);
  r.setState({ ...ANDROID_STATE, monkey: "** No activities found to run, monkey aborted.\n" });
  expect(await errorCode(() => r.op({ op: "phone.launch", ...t, app: "com.other.app" }))).toBe("not_found");

  r.setState({ ...ANDROID_STATE, pidof: { "com.acme.app": "1234" } });
  await r.op({ op: "phone.logs", ...t, app: "com.acme.app", lines: 50 });
  expect(r.calls()).toContainEqual(["adb", "-s", PIXEL, "logcat", "-d", "-t", "50", "--pid=1234"]);
  const whole = (await r.op({ op: "phone.logs", ...t, app: "com.idle.app", lines: 50 })) as { text: string };
  expect(whole.text).toStartWith("com.idle.app isn't running, so this is the phone's whole log.\n");
});

test("an .aab needs bundletool, which builds for this phone and installs through the running adb", async () => {
  const without = rig(ANDROID_STATE, { tools: ["adb", "xcrun", "xcode-select"] });
  writeFileSync(path.join(without.folder, "app.aab"), "AAB");
  const t = { platform: "android", serial: PIXEL, holder: without.holder("run-1") };
  expect(await errorCode(() => without.op({ op: "phone.install", ...t, path: "app.aab" }))).toBe("tool_missing");

  const r = rig(ANDROID_STATE);
  writeFileSync(path.join(r.folder, "app.aab"), "AAB");
  await r.op({ op: "phone.install", ...t, holder: r.holder("run-1"), path: "app.aab" });
  const steps = r.calls().filter((c) => c[0] === "bundletool");
  expect(steps.map((c) => c[1])).toEqual(["build-apks", "install-apks"]);
  expect(steps[0]).toContain(`--bundle=${path.join(r.folder, "app.aab")}`);
  expect(steps[0]).toContain(`--device-id=${PIXEL}`);
  expect(steps[1]?.some((a) => a.startsWith("--adb=") && a.endsWith("/bin/adb"))).toBe(true);
});

test("a locked Android phone: the op says unlock it, the list says so until it's unlocked", async () => {
  const r = rig({ ...ANDROID_STATE, keyguard: { [PIXEL]: "    mDreamingLockscreen=true" } });
  const t = { platform: "android", serial: PIXEL, holder: r.holder("run-1") };
  const err = await r.op({ op: "phone.launch", ...t, app: "com.acme.app" }).catch((e: Error) => e);
  expect(err).toMatchObject({ code: "phone_not_ready" });
  expect((err as Error).message).toBe("Sam's Pixel is locked. Unlock it and try again.");
  expect(r.calls()).toContainEqual(["adb", "-s", PIXEL, "shell", "input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard"]);
  expect(r.manager.list()[0]).toMatchObject({ state: "needs_you", reason: "locked" });
  await r.manager.poll();
  expect(r.manager.list()[0]).toMatchObject({ state: "needs_you", reason: "locked" });
  r.setState(ANDROID_STATE);
  await r.manager.poll();
  expect(r.manager.list()[0]?.state).toBe("ready");
  expect(await r.op({ op: "phone.launch", ...t, app: "com.acme.app" })).toEqual({ output: "Events injected: 1" });
});

test("recording an Android phone: scrcpy with the running adb, else the phone's own recorder pulled back", async () => {
  const r = rig(ANDROID_STATE);
  const t = { platform: "android", serial: PIXEL, holder: r.holder("run-1") };
  const rec = (await r.op({ op: "phone.record", ...t, seconds: 999 })) as { path: string; bytes: number };
  expect(rec.path).toMatch(/^\.agentes\/phone\/.+-recording\.mp4$/);
  expect(rec.bytes).toBe(7);
  const scrcpy = r.calls().find((c) => c[0] === "scrcpy");
  expect(scrcpy).toContain(`--serial=${PIXEL}`);
  expect(scrcpy).toContain("--time-limit=170");
  expect(scrcpy).toContain("--no-window");

  const plain = rig(ANDROID_STATE, { tools: ["adb"] });
  const p = (await plain.op({ op: "phone.record", ...t, holder: plain.holder("run-1"), seconds: 12 })) as {
    path: string;
  };
  expect(existsSync(path.join(plain.folder, p.path))).toBe(true);
  const shell = plain
    .calls()
    .filter((c) => c[0] === "adb" && c[3] === "shell" && String(c[4]).startsWith("screenrecord"));
  expect(shell[0]?.[4]).toMatch(
    /^screenrecord --time-limit 12 --bit-rate 2000000 \/data\/local\/tmp\/agentes-.+\.mp4$/,
  );
  expect(plain.calls().some((c) => c[0] === "adb" && c[3] === "pull")).toBe(true);
  expect(plain.calls().some((c) => c[0] === "adb" && String(c[4]).startsWith("rm -f /data/local/tmp/agentes-"))).toBe(
    true,
  );
});

test("a Maestro flow, recorded around: its YAML, log and video in the agent's folder", async () => {
  const r = rig({ ...ANDROID_STATE, wait: true });
  const t = { platform: "android", serial: PIXEL, holder: r.holder("run-1") };
  const flow = "appId: com.acme.app\n---\n- launchApp\n- tapOn: Checkout\n";
  const out = (await r.op({
    op: "phone.flow",
    ...t,
    flow,
    record: true,
    timeoutSeconds: 120,
    env: { USER_EMAIL: "sam@acme.test" },
  })) as { passed: boolean; video?: string; log: string; output: string };
  expect(out.passed).toBe(true);
  expect(out.output).toBe("Flow passed");
  expect(out.video).toMatch(/^\.agentes\/phone\/.+-flow\.mp4$/);
  expect(readFileSync(path.join(r.folder, out.log), "utf8")).toBe("Flow passed");
  const maestro = r.calls().find((c) => c[0] === "maestro") as string[];
  expect(maestro.slice(1, 6)).toEqual(["--device", PIXEL, "test", "-e", "USER_EMAIL=sam@acme.test"]);
  expect(readFileSync(maestro.at(-1) as string, "utf8")).toBe(flow);

  r.setState({ ...ANDROID_STATE, maestroExit: 1, maestroOutput: "Element not found: Checkout\n" });
  const failed = (await r.op({ op: "phone.flow", ...t, flow, timeoutSeconds: 60 })) as { passed: boolean };
  expect(failed.passed).toBe(false);
  expect(await errorCode(() => r.op({ op: "phone.flow", ...t, flow, timeoutSeconds: 60, env: { "A;B": "x" } }))).toBe(
    "bad_request",
  );
  r.setState({ ...ANDROID_STATE, javaMissing: true });
  expect(await errorCode(() => r.op({ op: "phone.flow", ...t, flow, timeoutSeconds: 60 }))).toBe("tool_missing");

  const noMaestro = rig(ANDROID_STATE, { tools: ["adb"] });
  expect(
    await errorCode(() =>
      noMaestro.op({ op: "phone.flow", ...t, holder: noMaestro.holder("run-1"), flow, timeoutSeconds: 60 }),
    ),
  ).toBe("tool_missing");
});

test("iOS simulator: install with its bundle id, launch, screenshot, record, flow, the app's log", async () => {
  const r = rig({ ...ANDROID_STATE, wait: true });
  const t = { platform: "ios", serial: SIM, holder: r.holder("run-1") };
  mkdirSync(path.join(r.folder, "Acme.app"));
  expect(await r.op({ op: "phone.install", ...t, path: "Acme.app" })).toEqual({
    app: "com.acme.app",
    output: "Installed",
  });
  expect(r.calls()).toContainEqual(["xcrun", "simctl", "install", SIM, path.join(r.folder, "Acme.app")]);
  expect(await errorCode(() => r.op({ op: "phone.install", ...t, path: "Acme.ipa" }))).toBe("bad_request");
  expect(await r.op({ op: "phone.launch", ...t, app: "com.acme.app" })).toEqual({ output: "com.acme.app: 4242" });
  const shot = (await r.op({ op: "phone.screenshot", ...t })) as { width: number };
  expect(shot.width).toBe(1080);
  const rec = (await r.op({ op: "phone.record", ...t, seconds: 1 })) as { bytes: number };
  expect(rec.bytes).toBe(7);
  const flow = (await r.op({
    op: "phone.flow",
    ...t,
    flow: "appId: com.acme.app\n---\n- launchApp\n",
    timeoutSeconds: 60,
  })) as {
    passed: boolean;
  };
  expect(flow.passed).toBe(true);
  const logs = (await r.op({ op: "phone.logs", ...t, app: "com.acme.app", lines: 2 })) as { text: string };
  expect(logs.text).toBe("three\n");
  const show = r.calls().find((c) => c[1] === "simctl" && c[2] === "spawn") as string[];
  expect(show.slice(-2)).toEqual(["--predicate", 'process == "Acme"']);
});

test("a real iPhone: install and launch through devicectl, the rest through its test helper once it's set up", async () => {
  const [wda, mjpeg] = [await freePort(), await freePort()];
  const muxDir = tempDir("mux-");
  dirs.push(muxDir);
  const mux = await fakeUsbmuxd(muxDir, [{ id: 5, serial: IPHONE }], { 8100: wda, 9100: mjpeg });
  let helper: IosHelper | null = null;
  const r = rig(
    {
      ...ANDROID_STATE,
      wdaTree: {
        type: "Application",
        children: [{ type: "Button", label: "Sign in", rect: { x: 0, y: 100, width: 390, height: 44 } }],
      },
    },
    {
      tools: ["adb", "xcrun", "xcode-select", "maestro", "plutil", "ffmpeg"],
      ios: (env, root, now) => {
        mkdirSync(
          path.join(root, ".agentes-runner", "wda", "src", `WebDriverAgent-${WDA_VERSION}`, "WebDriverAgent.xcodeproj"),
          {
            recursive: true,
          },
        );
        helper = new IosHelper({
          home: root,
          env: { ...env, FAKE_WDA_PORT: String(wda), FAKE_MJPEG_PORT: String(mjpeg) },
          log: () => {},
          now,
          usbmuxSocket: mux.file,
          teams: async () => [{ id: "A1B2C3D4E5", name: "Sam Rivera", free: true }],
        });
        return helper;
      },
    },
  );
  try {
    const t = { platform: "ios", serial: IPHONE, holder: r.holder("run-1") };
    await r.manager.poll();
    // Plugged in: the Mac builds the helper by itself, and says so on the phone.
    expect(r.manager.list().find((p) => p.serial === IPHONE)).toMatchObject({
      state: "preparing",
      reason: "helper_missing",
    });
    // Meanwhile it installs and opens apps, but takes no screenshot yet.
    writeFileSync(path.join(r.folder, "Acme.ipa"), "IPA");
    expect(await r.op({ op: "phone.install", ...t, path: "Acme.ipa" })).toEqual({
      app: "com.acme.app",
      output: "Installed",
    });
    const install = r.calls().find((c) => c[1] === "devicectl" && c[2] === "device") as string[];
    expect(install.slice(1, 8)).toEqual([
      "devicectl",
      "device",
      "install",
      "app",
      "--device",
      IPHONE,
      path.join(r.folder, "Acme.ipa"),
    ]);
    await r.op({ op: "phone.launch", ...t, app: "com.acme.app" });
    expect(await errorCode(() => r.op({ op: "phone.screenshot", ...t }))).toBe("phone_not_ready");
    for (let i = 0; i < 200 && r.manager.list().find((p) => p.serial === IPHONE)?.state !== "ready"; i++) {
      await Bun.sleep(50);
      await r.manager.poll();
    }
    expect(r.manager.list().find((p) => p.serial === IPHONE)?.state).toBe("ready");
    const shot = (await r.op({ op: "phone.screenshot", ...t })) as { path: string; width: number };
    expect(shot.width).toBe(1080);
    expect(readFileSync(path.join(r.folder, shot.path)).subarray(1, 4).toString()).toBe("PNG");
    const rec = (await r.op({ op: "phone.record", ...t, seconds: 1 })) as { path: string; bytes: number };
    expect(rec).toMatchObject({ path: expect.stringMatching(/recording\.mp4$/), bytes: 7 });
    const ffmpeg = r.calls().find((c) => c[0] === "ffmpeg" && c.includes("pipe:0")) as string[];
    expect(ffmpeg).toContain("h264_videotoolbox");
    // Maestro dropped real iPhones: the flow runs through the helper.
    const flow = (await r.op({
      op: "phone.flow",
      ...t,
      flow: "appId: com.acme.app\n---\n- launchApp\n- tapOn: Sign in\n- takeScreenshot: signed in\n",
      record: true,
      timeoutSeconds: 60,
    })) as { passed: boolean; output: string; video?: string; log: string };
    expect(flow.passed).toBe(true);
    expect(flow.video).toMatch(/flow\.mp4$/);
    expect(flow.output).toContain("OK      tapOn Sign in");
    expect(flow.output).toMatch(/Screenshot: \.agentes\/phone\/.+-signed-in\.png/);
    expect(r.calls().some((c) => c[0] === "maestro")).toBe(false);
    const wdaCalls = r
      .calls()
      .filter((c) => c[0] === "wda")
      .map((c) => `${c[1]} ${c[2]}`);
    expect(wdaCalls).toContain("POST /session/s1/wda/apps/launch");
    expect(wdaCalls).toContain("POST /session/s1/wda/tap");
    // A flow that isn't YAML is refused before a recording starts.
    const recordings = r.calls().filter((c) => c[0] === "ffmpeg").length;
    expect(
      await errorCode(() =>
        r.op({ op: "phone.flow", ...t, flow: "- tapOn: [unclosed\n", record: true, timeoutSeconds: 60 }),
      ),
    ).toBe("bad_request");
    expect(r.calls().filter((c) => c[0] === "ffmpeg")).toHaveLength(recordings);
    // What needs the person, in words: the developer not trusted.
    r.setState({
      ...ANDROID_STATE,
      launchFail:
        "ERROR: The application could not be launched because its profile has not been explicitly trusted by the user.\n",
    });
    const untrusted = await r.op({ op: "phone.launch", ...t, app: "com.acme.app" }).catch((e: Error) => e);
    expect(untrusted).toMatchObject({ code: "phone_not_ready" });
    // No libimobiledevice: its log can't be read.
    expect(await errorCode(() => r.op({ op: "phone.logs", ...t, lines: 10 }))).toBe("tool_missing");
    const withSyslog = rig(ANDROID_STATE);
    const live = (await withSyslog.op({
      op: "phone.logs",
      ...t,
      holder: withSyslog.holder("run-1"),
      app: "com.acme.app",
      lines: 10,
    })) as {
      text: string;
    };
    expect(live.text).toContain("com.acme.app hello");
  } finally {
    (helper as IosHelper | null)?.stopAll();
    mux.close();
  }
});

test("the runner routes phone ops with commands off, refuses them paused, and hands them the agent's folder", async () => {
  const workspace = tempDir("ws-");
  dirs.push(workspace);
  const agent = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "lia", name: "Lia" };
  const seen: { op: string; folder: string | null; file?: string; outside?: string }[] = [];
  const phones = {
    handle: async (req: PhoneRequest, io: PhoneIo) => {
      const at: (typeof seen)[number] = { op: req.op, folder: io.folder };
      if (req.op === "phone.install") {
        at.file = await io.resolve(req.path);
        at.outside = await io.resolve("../../etc/hosts").catch((e: RunnerError) => e.code);
      }
      seen.push(at);
      return { ok: true };
    },
  } as unknown as PhoneManager;
  let paused = false;
  const ctx: HandlerContext = {
    workspaceReal: workspace,
    exec: false,
    token: "agm_x",
    access: () => ({ folders: [], tools: { claude: false, codex: false, commands: false } }),
    paused: () => paused,
    phones,
  };
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const target = {
    platform: "android" as const,
    serial: PIXEL,
    holder: { runId: "r", agentId: "a", userId: "u", since: "" },
  };
  await handleRequest(ctx, { op: "phone.claim", ...target, agent }, scope);
  const folder = seen[0]?.folder as string;
  expect(path.dirname(folder)).toBe(workspace);
  writeFileSync(path.join(folder, "app.apk"), "APK");
  await handleRequest(ctx, { op: "phone.install", ...target, path: "app.apk", agent }, scope);
  expect(seen[1]).toEqual({
    op: "phone.install",
    folder,
    file: path.join(folder, "app.apk"),
    outside: "outside_workspace",
  });
  paused = true;
  expect(await errorCode(() => handleRequest(ctx, { op: "phone.screenshot", ...target, agent }, scope))).toBe("paused");
  // Letting go is never new work.
  await handleRequest(ctx, { op: "phone.release", ...target, agent }, scope);
  expect(seen.at(-1)?.op).toBe("phone.release");
  expect(
    await errorCode(() =>
      handleRequest({ ...ctx, phones: undefined, paused: () => false }, { op: "phone.claim", ...target }, scope),
    ),
  ).toBe("phone_missing");
  // The process that holds the phones' locks answers them, in either mode.
  for (const op of ["phone.claim", "phone.release", "phone.flow", "phone.logs"] as const)
    expect(OP_ROUTES[op]).toBe("machine");
});

test("a manager that only looks (doctor) changes no setting, and sees a phone another runner holds", async () => {
  const r = rig(ANDROID_STATE, { readOnly: true });
  // The setting is written without waiting for it: a few looks give it time to land.
  for (let i = 0; i < 3; i++) await r.manager.poll();
  expect(r.manager.list().find((p) => p.serial === PIXEL)?.state).toBe("ready");
  expect(r.calls().some((c) => c.join(" ").includes("settings put"))).toBe(false);
  const pixel = { platform: "android", serial: PIXEL };
  expect(r.manager.heldElsewhere(pixel)).toBeNull();
  // Another live process of this user (here the test's parent) holds it, in the lock file the phone ops take.
  const held = acquireLock(path.join(r.root, "locks"), "phone", { file: `android_${PIXEL}.lock`, pid: process.ppid });
  if (!held.ok) throw new Error("no lock");
  expect(r.manager.heldElsewhere(pixel)).toMatch(/^\d{4}-\d\d-\d\dT/);
  held.release();
});

test("a manager that only looks (doctor) builds no iPhone test helper and runs nothing on the iPhone", async () => {
  const r = rig(ANDROID_STATE, {
    tools: ["adb", "xcrun", "xcode-select", "plutil"],
    readOnly: true,
    ios: (env, root, now) =>
      new IosHelper({ home: root, env, log: () => {}, now, teams: async () => [{ id: "A1B2C3D4E5", name: "Sam Rivera", free: true }] }),
  });
  for (let i = 0; i < 3; i++) await r.manager.poll();
  await Bun.sleep(100);
  expect(r.manager.list().find((p) => p.serial === IPHONE)).toMatchObject({ state: "preparing", reason: "helper_missing" });
  expect(r.calls().some((c) => c[0] === "xcrun" && c[1] === "xcodebuild")).toBe(false);
});

/** A viewer's data socket in memory: what the runner sent, how it closed, and its listener to play the viewer. */
function viewerSocket() {
  const sent: (string | Uint8Array)[] = [];
  let listener: DataListener | null = null;
  const closed: { code?: number; reason?: string }[] = [];
  const socket: DataSocket = {
    send: (d) => {
      sent.push(d);
    },
    close: (code, reason) => {
      closed.push({ code, reason });
      listener?.closed();
    },
    bufferedAmount: 0,
    listen: (on) => {
      listener = on;
    },
  };
  return { socket, sent, closed, viewer: () => listener as DataListener };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

test("a phone's screen live: pictures until the viewer stops acknowledging, an unchanged screen sent once", async () => {
  const r = rig({ ...ANDROID_STATE, changing: true });
  const v = viewerSocket();
  const person = { runId: null, agentId: null, userId: "user-sam", since: "" };
  await r.manager.view({ platform: "android", serial: PIXEL, holder: person }, "watch", async () => v.socket);
  // The first picture is taken before the socket opens, so a phone that can't show refuses the stream instead.
  await until(() => v.sent.length >= 2, "two pictures");
  await wait(600);
  // Two on their way and none acknowledged: it waits.
  expect(v.sent).toHaveLength(2);
  expect(pngSize(Buffer.from(v.sent[0] as Uint8Array))).toEqual({ width: 1080, height: 2400 });
  v.viewer().control?.({ type: "ack" });
  await until(() => v.sent.length === 3, "a third picture once one was drawn");
  // Watching never takes the phone, and input from a watcher goes nowhere.
  v.viewer().control?.({ type: "tap", x: 0.5, y: 0.5 });
  await wait(200);
  expect(r.calls().some((c) => c.join(" ").includes("input tap"))).toBe(false);
  expect(r.manager.list()[0]?.holder).toBeUndefined();
  v.viewer().closed();
  const shots = r.calls().filter((c) => c.includes("screencap")).length;
  await wait(600);
  expect(r.calls().filter((c) => c.includes("screencap")).length).toBe(shots);

  // An unchanged screen: one picture, however long it shows.
  r.setState(ANDROID_STATE);
  const still = viewerSocket();
  await r.manager.view({ platform: "android", serial: PIXEL, holder: person }, "watch", async () => still.socket);
  for (let i = 0; i < 3; i++) {
    await wait(450);
    still.viewer().control?.({ type: "ack" });
  }
  expect(still.sent).toHaveLength(1);
  still.viewer().closed();
});

test("control: the person's input goes to the phone, an agent holding it waits, and gets it back after", async () => {
  const r = rig(ANDROID_STATE);
  const target = { platform: "android", serial: PIXEL };
  await r.op({ op: "phone.claim", ...target, holder: r.holder("run-1", "Testing checkout") });
  const v = viewerSocket();
  const sam = { runId: null, agentId: null, userId: "user-sam", since: "" };
  await r.manager.view({ platform: "android", serial: PIXEL, holder: sam }, "control", async () => v.socket);
  // The person holds it now; the agent's calls wait until they give it back.
  expect(r.manager.list()[0]?.holder).toMatchObject({ runId: null, userId: "user-sam" });
  expect(await errorCode(() => r.op({ op: "phone.screenshot", ...target, holder: r.holder("run-1") }))).toBe(
    "phone_busy",
  );
  // Taking control lights the screen up.
  expect(r.calls()).toContainEqual(["adb", "-s", PIXEL, "shell", "input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard"]);
  const viewer = v.viewer();
  viewer.control?.({ type: "tap", x: 0.5, y: 0.25 });
  viewer.control?.({ type: "swipe", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, ms: 300 });
  viewer.control?.({ type: "text", text: "it's 5" });
  viewer.control?.({ type: "text", text: " o'clock" });
  viewer.control?.({ type: "key", key: "home" });
  const input = () =>
    r.calls().filter((c) => c[3] === "shell" && /^input (tap|swipe|text|keyevent \d)/.test(String(c[4])));
  await until(() => input().length >= 4, "the input");
  expect(input().map((c) => c[4])).toEqual([
    "input tap 540 600",
    "input swipe 540 1920 540 480 300",
    // Typed while the tap and the swipe went in: one call.
    "input text 'it'\\''s%s5%so'\\''clock'",
    "input keyevent 3",
  ]);
  // Given back: the agent holds it again.
  viewer.closed();
  await until(() => r.manager.list()[0]?.holder?.runId === "run-1", "the agent's hold back");
  await r.op({ op: "phone.screenshot", ...target, holder: r.holder("run-1") });

  // The run ends while the person controls it: the phone goes free when they give it back.
  const again = viewerSocket();
  await r.manager.view({ platform: "android", serial: PIXEL, holder: sam }, "control", async () => again.socket);
  expect(await r.op({ op: "phone.release", ...target, holder: r.holder("run-1") })).toEqual({ released: true });
  again.viewer().closed();
  await until(() => r.manager.list()[0]?.holder === undefined, "the phone free");

  // Stop (its owner, by force) ends a person's control too: their view closes as control ended.
  const third = viewerSocket();
  await r.manager.view({ platform: "android", serial: PIXEL, holder: sam }, "control", async () => third.socket);
  // Someone else can't take it meanwhile.
  const ana = { runId: null, agentId: null, userId: "user-ana", since: "" };
  expect(
    await errorCode(() =>
      r.manager.view({ platform: "android", serial: PIXEL, holder: ana }, "control", async () => viewerSocket().socket),
    ),
  ).toBe("phone_busy");
  await r.op({ op: "phone.release", ...target, holder: r.holder("run-9"), force: true });
  expect(third.closed).toEqual([{ code: 4410, reason: "control ended" }]);
});

test("an agent's op running when a person takes control stops, and says why", async () => {
  const r = rig({ ...ANDROID_STATE, wait: true }, {});
  const target = { platform: "android", serial: PIXEL };
  const recording = r.op({ op: "phone.record", ...target, holder: r.holder("run-1"), seconds: 30 }).catch((e) => e);
  await until(() => r.calls().some((c) => c[0] === "scrcpy"), "the recording");
  const v = viewerSocket();
  const sam = { runId: null, agentId: null, userId: "user-sam", since: "" };
  await r.manager.view({ platform: "android", serial: PIXEL, holder: sam }, "control", async () => v.socket);
  const error = (await recording) as RunnerError;
  expect(error.code).toBe("phone_busy");
  expect(error.message).toContain("took control");
  v.viewer().closed();
});

test("Stop while the screen opens in control ends it as soon as it's open; big pictures go one at a time", async () => {
  const r = rig(ANDROID_STATE);
  const target = { platform: "android", serial: PIXEL } as const;
  const sam = { runId: null, agentId: null, userId: "user-sam", since: "" };
  const v = viewerSocket();
  await r.manager.view({ ...target, holder: sam }, "control", async () => {
    await r.op({ op: "phone.release", ...target, holder: r.holder("run-9"), force: true });
    return v.socket;
  });
  expect(v.closed).toEqual([{ code: 4410, reason: "control ended" }]);
  v.viewer().control?.({ type: "tap", x: 0.5, y: 0.5 });
  await wait(100);
  expect(r.calls().some((c) => c.join(" ").includes("input tap"))).toBe(false);

  // Two of Sam's views taking control at once share it: the phone goes free once both closed.
  const a = viewerSocket();
  const b = viewerSocket();
  await Promise.all([
    r.manager.view({ ...target, holder: sam }, "control", async () => a.socket),
    r.manager.view({ ...target, holder: sam }, "control", async () => b.socket),
  ]);
  a.viewer().closed();
  expect(r.manager.list()[0]?.holder).toMatchObject({ userId: "user-sam" });
  b.viewer().closed();
  await until(() => r.manager.list()[0]?.holder === undefined, "the phone free");

  r.setState({ ...ANDROID_STATE, changing: true, big: true });
  const big = viewerSocket();
  await r.manager.view({ ...target, holder: sam }, "watch", async () => big.socket);
  await wait(600);
  expect(big.sent).toHaveLength(1);
  big.viewer().control?.({ type: "ack" });
  await until(() => big.sent.length === 2, "the next picture once the big one was drawn");
  big.viewer().closed();
});

test("iPhones: a simulator shows its pictures but takes no control, a real one needs the helper, a registered driver wins", async () => {
  const r = rig(ANDROID_STATE);
  const v = viewerSocket();
  const sam = { runId: null, agentId: null, userId: "user-sam", since: "" };
  await r.manager.view({ platform: "ios", serial: SIM, holder: sam }, "watch", async () => v.socket);
  await until(() => v.sent.length === 1, "the simulator's picture");
  expect(r.calls()).toContainEqual(["xcrun", "simctl", "io", SIM, "screenshot", "--type=jpeg", "-"]);
  v.viewer().closed();
  const control = await r.manager
    .view({ platform: "ios", serial: SIM, holder: sam }, "control", async () => viewerSocket().socket)
    .catch((e: RunnerError) => e);
  expect(control).toMatchObject({ code: "unsupported", message: NO_IOS_CONTROL });
  expect(
    await errorCode(() =>
      r.manager.view({ platform: "ios", serial: IPHONE, holder: sam }, "watch", async () => viewerSocket().socket),
    ),
  ).toBe("tool_missing");

  const taps: number[][] = [];
  const helper: PhoneScreenDriver = {
    frame: async () => ({ jpeg: new Uint8Array([0xff, 0xd8, 1]), width: 402, height: 874 }),
    tap: async (x, y) => {
      taps.push([x, y]);
    },
    swipe: async () => {},
    text: async () => {},
    key: async () => {},
  };
  registerIosScreenDriver((phone) => (phone.kind === "device" ? helper : null));
  try {
    const real = viewerSocket();
    await r.manager.view({ platform: "ios", serial: IPHONE, holder: sam }, "control", async () => real.socket);
    real.viewer().control?.({ type: "tap", x: 0.5, y: 0.5 });
    await until(() => taps.length === 1, "the helper's tap");
    // In the helper's own space: the size its pictures said.
    expect(taps).toEqual([[201, 437]]);
    real.viewer().closed();
    // A simulator the helper leaves alone keeps the built-in pictures.
    const sim = { platform: "ios", serial: SIM, kind: "simulator", model: "", osVersion: "", state: "ready" } as const;
    expect(screenDriverFor(sim, { adb: null, xcrun: "/x", env: {} })).toBeInstanceOf(SimulatorScreen);
  } finally {
    registerIosScreenDriver(null);
  }
});

test("input lands where the person pressed, in the picture's own size; text is one quoted word for the phone's shell", async () => {
  const seen: unknown[] = [];
  const driver = {
    tap: async (...a: number[]) => void seen.push(["tap", ...a]),
    swipe: async (...a: number[]) => void seen.push(["swipe", ...a]),
    text: async (t: string) => void seen.push(["text", t]),
    key: async (k: string) => void seen.push(["key", k]),
  } as unknown as PhoneScreenDriver;
  const size = { width: 1080, height: 2400 };
  await applyInput(driver, { type: "tap", x: 1, y: 0 }, size);
  await applyInput(driver, { type: "swipe", x1: 0, y1: 0.5, x2: 0.25, y2: 0.5, ms: 120 }, size);
  expect(seen).toEqual([
    ["tap", 1079, 0],
    ["swipe", 0, 1200, 270, 1200, 120],
  ]);
  expect(androidText(`a b'c"; rm -rf $HOME \\`)).toBe(`'a%sb'\\''c";%srm%s-rf%s$HOME%s\\'`);
});

test("stream.open for a phone's screen needs no agent, goes to the phones, and control waits on a paused computer", async () => {
  const views: unknown[] = [];
  const dialed: string[] = [];
  const phones = {
    view: async (target: unknown, mode: string, dial: () => Promise<DataSocket>) => {
      views.push({ target, mode });
      await dial();
    },
  } as unknown as PhoneManager;
  const streams = {
    dial: async (_id: string, kind: string) => {
      dialed.push(kind);
      return viewerSocket().socket;
    },
  } as unknown as DataSockets;
  let paused = false;
  const ctx: HandlerContext = {
    workspaceReal: "/tmp",
    exec: false,
    token: "agm_x",
    phones,
    streams,
    paused: () => paused,
  };
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const phone = {
    platform: "android" as const,
    serial: PIXEL,
    holder: { runId: null, agentId: null, userId: "user-sam", since: "" },
  };
  const open = (mode: "watch" | "control") =>
    ({ op: "stream.open", kind: "phone", mode, phoneId: "p1", streamId: "A".repeat(43), phone }) as const;
  expect(await handleRequest(ctx, open("control"), scope)).toEqual({ opened: true });
  expect(views).toEqual([{ target: phone, mode: "control" }]);
  expect(dialed).toEqual(["phone"]);
  paused = true;
  expect(await errorCode(() => handleRequest(ctx, open("control"), scope))).toBe("paused");
  expect(await handleRequest(ctx, open("watch"), scope)).toEqual({ opened: true });
});
