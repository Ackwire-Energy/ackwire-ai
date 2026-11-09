import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, fakeDevicesOf, fakeMachinesOf } from "./fake-api";
import { notification } from "./fakes/notifications";
import { acmeDevices, acmeState, IMAC, IPHONE, LIA, MAC, ORG_ID, PIXEL, RUI } from "./fixtures/devices";
import { renderApp, screen, settle, showIn } from "./render";

afterEach(() => {
  cleanup();
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** What the 2 s poll or a devices event would do: ask the server again now. */
const refetch = async (services: Awaited<ReturnType<typeof renderApp>>["services"]) => {
  await act(async () => {
    await services.queryClient.invalidateQueries({ queryKey: ["org"] });
  });
  await settle(4);
};
const calls = (state: ReturnType<typeof acmeState>, method: string) => state.calls.filter((c) => c.method === method);

async function open(
  path: string,
  setup?: (devices: NonNullable<ReturnType<typeof fakeDevicesOf.get>>) => void,
  state = acmeState(),
) {
  const api = createFakeApi(state);
  const devices = fakeDevicesOf.get(api);
  if (!devices) throw new Error("no devices fake");
  devices.set(acmeDevices());
  fakeMachinesOf.get(api)?.setRelease({
    version: "1.8.0",
    url: "/api/desktop/download/1.8.0/agentes.dmg",
    sha256: "0".repeat(64),
    publishedAt: "2026-11-01T12:00:00.000Z",
  });
  setup?.(devices);
  const app = await renderApp(path, { api });
  await settle(6);
  await showIn(app.services, "en");
  return { ...app, state, devices, api };
}

describe("Settings › Devices", () => {
  test("old Computers links land on Devices", async () => {
    const { router } = await open(`/org/${ORG_ID}/settings/computers`);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices`);
    const old = await open(`/org/${ORG_ID}/settings/computers/${MAC}`);
    expect(old.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/devices/${MAC}`);
  });

  test("the list: computers with their phones nested, states with their detail, whose and who can use it", async () => {
    await open(`/org/${ORG_ID}/settings/devices`);
    const list = screen().getByRole("list", { name: "Devices" });
    const rows = [...list.querySelectorAll(".dv-row")];
    expect(rows.map((r) => r.querySelector(".dv-row__name")?.textContent)).toEqual([
      "Workspace computer",
      "Sam's MacBook Pro",
      "Pixel 8",
      "Sam's iPhone 16",
      "Windows build PC",
      "build-box",
      "Ana's iMac",
      "Ana's iPhone 15",
    ]);
    const pixel = rows[2] as HTMLElement;
    expect(pixel.classList.contains("dv-row--child")).toBe(true);
    expect(pixel.querySelector(".dv-status")?.textContent).toBe("In use by Lia");
    expect(pixel.querySelector(".dv-row__detail")?.textContent).toMatch(/^for Rui since /);
    expect(pixel.querySelector(".dv-row__who")?.textContent).toBe("Everyone, phone only");
    const iphone = rows[3] as HTMLElement;
    expect(iphone.querySelector(".dv-status")?.getAttribute("data-status")).toBe("needs");
    expect(iphone.querySelector(".dv-row__detail")?.textContent).toBe("Turn on Developer Mode");
    expect(iphone.querySelector(".dv-row__who")?.textContent).toBe("Same as its Mac");
    expect(rows[4]?.querySelector(".dv-status")?.textContent).toBe("Busy 1/1");
    expect(rows[4]?.querySelector(".dv-row__owner")?.textContent).toBe("Workspace");
    expect(rows[6]?.querySelector(".dv-row__detail")?.textContent).toMatch(/^last seen /);
    expect(rows[7]?.querySelector(".dv-row__detail")?.textContent).toBe("with Ana's iMac");
    // The workspace computer has no menu.
    expect(rows[0]?.querySelector(".dv-row__end button")).toBeNull();
    // A computer asking to join sits on top.
    expect(screen().getByRole("list", { name: "Asking to join" }).textContent).toContain(
      "ci-runner wants to join Acme",
    );
  });

  test("filters and search", async () => {
    await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("radio", { name: /Phones/ }));
    const names = () =>
      [...screen().getByRole("list", { name: "Devices" }).querySelectorAll(".dv-row__name")].map((n) => n.textContent);
    expect(names()).toEqual(["Pixel 8", "Sam's iPhone 16", "Ana's iPhone 15"]);
    await click(screen().getByRole("radio", { name: /All/ }));
    const search = screen().getByRole("searchbox", { name: "Search devices" });
    await act(async () => fireEvent.change(search, { target: { value: "pixel" } }));
    await settle(2);
    expect(names()).toEqual(["Sam's MacBook Pro", "Pixel 8"]);
  });

  test("Let it join, from the list: name and who can use it, then the server lets it in", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices`);
    const ask = screen().getByRole("list", { name: "Asking to join" });
    await click(within(ask).getByRole("button", { name: "Let it join" }));
    const dialog = screen().getByRole("dialog", { name: "ci-runner wants to join Acme" });
    expect(dialog.textContent).toContain("203.0.113.7");
    await click(within(dialog).getByRole("button", { name: "Let it join" }));
    expect(calls(state, "devices.approveRequest")[0]?.args.slice(1)).toEqual([
      "r-ci",
      { name: "ci-runner", audience: { mode: "owner", userIds: [], roleIds: [] } },
    ]);
  });
});

describe("Connect a device", () => {
  test("a server: the one line, then the computer asking to join, then connected", async () => {
    const { state, devices, services } = await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("button", { name: "Connect a device" }));
    const chooser = screen().getByRole("dialog", { name: "Connect a device" });
    expect(chooser.textContent).toContain("Android phone");
    await click(within(chooser).getByRole("button", { name: /A server or VPS/ }));
    const dialog = screen().getByRole("dialog", { name: "Connect a server" });
    expect(dialog.querySelector("code")?.textContent).toBe("curl -fsSL https://app.agentes.chat/i/7KQ2-M9X1 | sh");
    expect(dialog.textContent).toContain("Works once, for 10 minutes");
    expect(dialog.textContent).toContain("Waiting for the server…");
    await click(within(dialog).getByRole("radio", { name: "Windows" }));
    expect(dialog.querySelector("code")?.textContent).toBe("irm https://app.agentes.chat/i/7KQ2-M9X1/ps | iex");
    devices.setLink({ status: "asking", request: acmeDevices().requests[0] });
    await refetch(services);
    const asking = screen().getByRole("dialog", { name: "ci-runner wants to join Acme" });
    await click(within(asking).getByRole("button", { name: "Let it join" }));
    // A server is everyone's by default.
    expect(calls(state, "devices.approveRequest")[0]?.args[2]).toEqual({
      name: "ci-runner",
      audience: { mode: "everyone", userIds: [], roleIds: [] },
    });
    expect(screen().getByRole("dialog", { name: "ci-runner is connected" })).toBeTruthy();
  });

  test("an Android phone: the computer's live checklist, Allow on the phone, then connected", async () => {
    const { devices, services } = await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("button", { name: "Connect a device" }));
    await click(screen().getByRole("button", { name: /Android phone/ }));
    const dialog = screen().getByRole("dialog", { name: "Connect an Android phone" });
    expect(dialog.textContent).toContain("Looking for a phone on Sam's MacBook Pro…");
    expect(dialog.querySelector(".dv-qr svg")).toBeTruthy();
    const list = acmeDevices();
    const mac = list.devices.find((d) => d.id === MAC);
    const pixel = mac?.phones.find((p) => p.id === PIXEL);
    if (!mac || !pixel) throw new Error("fixture");
    mac.phones.push({
      ...pixel,
      id: "p-new",
      name: "Galaxy S24",
      status: { kind: "needs_you", reason: "unauthorized" },
    });
    devices.set(list);
    await refetch(services);
    const allow = dialog.querySelector('.dv-step[data-state="needs"]');
    expect(allow?.textContent).toContain("Tap Allow on the phone");
    expect(allow?.textContent).toContain("Allow USB debugging?");
    const added = mac.phones.at(-1);
    if (added) added.status = { kind: "ready" };
    devices.set(list);
    await refetch(services);
    expect(screen().getByRole("dialog", { name: "Galaxy S24 is connected" })).toBeTruthy();
  });

  test("an Android phone over Wi-Fi: Android's pairing QR, the computer's live line, then connected", async () => {
    const { state, devices, services } = await open(`/org/${ORG_ID}/settings/devices`);
    const ask = async () => {
      await act(async () => {
        await services.queryClient.invalidateQueries({ queryKey: ["wifi-pair-state"] });
      });
      await refetch(services);
    };
    await click(screen().getByRole("button", { name: "Connect a device" }));
    await click(screen().getByRole("button", { name: /Android phone/ }));
    const dialog = screen().getByRole("dialog", { name: "Connect an Android phone" });
    await click(within(dialog).getByRole("radio", { name: "Over Wi-Fi" }));
    expect(calls(state, "devices.startWifiPairing")[0]?.args).toEqual([ORG_ID, MAC, {}]);
    expect(dialog.querySelector('.dv-qr svg[aria-label="QR code for Wireless debugging on the phone"]')).toBeTruthy();
    expect(dialog.querySelector('.dv-step[data-state="current"]')?.textContent).toContain(
      "Waiting for the phone to scan…",
    );
    expect(dialog.querySelector(".ac-setpath")?.textContent).toBe("Wireless debuggingPair device with QR code");
    devices.setPairing({ state: "pairing" });
    await ask();
    expect(dialog.textContent).toContain("Found a phone. Pairing…");
    expect(dialog.querySelector(".dv-qr--used")).toBeTruthy();

    // Nothing in 2 minutes: the cause, and Try again makes a new code.
    devices.setPairing({ state: "failed", reason: "timed_out" });
    await ask();
    const failed = dialog.querySelector('.dv-step[data-state="needs"]');
    expect(failed?.textContent).toContain(
      "Nothing scanned the code in 2 minutes. Check the phone is on the same Wi-Fi as Sam's MacBook Pro and try again.",
    );
    await click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(calls(state, "devices.startWifiPairing")).toHaveLength(2);

    // The six-digit way: what the phone shows, typed here.
    await click(within(dialog).getByRole("button", { name: "Use a pairing code instead" }));
    expect(calls(state, "devices.cancelWifiPairing").length).toBeGreaterThan(0);
    const pairButton = within(dialog).getByRole("button", { name: "Pair" }) as HTMLButtonElement;
    expect(pairButton.disabled).toBe(true);
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("IP address and port"), {
        target: { value: "192.168.1.20:37099" },
      });
      fireEvent.change(within(dialog).getByLabelText("Wi-Fi pairing code"), { target: { value: "123456" } });
    });
    await click(pairButton);
    expect(calls(state, "devices.startWifiPairing").at(-1)?.args).toEqual([
      ORG_ID,
      MAC,
      { address: "192.168.1.20:37099", code: "123456" },
    ]);
    const list = acmeDevices();
    const mac = list.devices.find((d) => d.id === MAC);
    const pixel = mac?.phones.find((p) => p.id === PIXEL);
    if (!mac || !pixel) throw new Error("fixture");
    mac.phones.push({ ...pixel, id: "p-wifi", name: "Galaxy S24", transport: "wifi", status: { kind: "ready" } });
    devices.set(list);
    devices.setPairing({ state: "connected", phoneId: "p-wifi" });
    await ask();
    expect(screen().getByRole("dialog", { name: "Galaxy S24 is connected" })).toBeTruthy();
  });

  test("the Android steps draw Android's own prompt in Portuguese", async () => {
    const app = await open(`/org/${ORG_ID}/settings/devices/android-setup?computer=${MAC}`);
    await showIn(app.services, "pt-BR");
    const dialog = screen().getByRole("dialog", { name: "Conectar um celular Android" });
    expect(dialog.textContent).toContain("Permitir a depuração USB?");
    expect(dialog.textContent).toContain("Sempre permitir neste computador");
  });

  test("an iPhone: the checklist mirrors the Mac, Developer Mode as a Settings path", async () => {
    await open(`/org/${ORG_ID}/settings/devices`);
    await click(screen().getByRole("button", { name: "Connect a device" }));
    await click(screen().getByRole("button", { name: /iPhone/ }));
    const dialog = screen().getByRole("dialog", { name: "Connect an iPhone" });
    const states = [...dialog.querySelectorAll(".dv-step")].map((s) => s.getAttribute("data-state"));
    expect(states).toEqual(["done", "done", "done", "done", "done", "needs", "waiting", "waiting"]);
    expect(dialog.querySelector(".ac-setpath")?.textContent).toBe("SettingsPrivacy & SecurityDeveloper Mode");
  });
});

describe("A device's page", () => {
  test("a phone in use: Stop, and who can use it", async () => {
    const { state } = await open(`/org/${ORG_ID}/settings/devices/phones/${PIXEL}`);
    const line = document.querySelector(".dv-statusline");
    expect(line?.textContent).toContain("In use by Lia");
    expect(line?.textContent).toContain("Recording a test video");
    await click(within(line as HTMLElement).getByRole("button", { name: "Stop" }));
    expect(calls(state, "devices.stopPhone")[0]?.args).toEqual([ORG_ID, PIXEL]);
  });

  test("a phone's screen: watched while Lia uses it, taken by its owner, input as frames, given back", async () => {
    const drawn = globalThis.createImageBitmap;
    globalThis.createImageBitmap = (async () => ({ width: 1080, height: 2400, close() {} })) as never;
    try {
      const { sockets } = await open(`/org/${ORG_ID}/settings/devices/phones/${PIXEL}`);
      const screens = () => sockets.sockets.filter((s) => s.url.includes("/api/phone-screen"));
      const watch = screens().at(-1);
      expect(watch?.url).toContain(`phoneId=${PIXEL}&mode=watch`);
      const card = screen().getByRole("region", { name: "Screen" });
      expect(card.textContent).toContain("Lia is using it for Rui");
      expect(card.textContent).toContain("Taking control pauses Lia until you give it back.");
      expect(within(card).queryByRole("button", { name: "Take control" })).toBeNull();
      // Its first picture: live, acknowledged, and Take control shows.
      const picture = async (s: (typeof sockets.sockets)[number]) => {
        await act(async () => {
          s.onmessage?.({ data: new ArrayBuffer(8) });
        });
        await settle(4);
      };
      await act(async () => watch?.open());
      await picture(watch as (typeof sockets.sockets)[number]);
      expect(watch?.sent).toEqual([{ type: "ack" }]);
      await click(within(card).getByRole("button", { name: "Take control" }));
      expect(watch?.closed).toBe(true);
      const control = screens().at(-1) as (typeof sockets.sockets)[number];
      expect(control.url).toContain("mode=control");
      await act(async () => control.open());
      // Nothing of its own until its first picture: opening, and no input goes anywhere yet.
      expect(card.textContent).toContain("Opening the screen…");
      expect(card.textContent).not.toContain("You're in control");
      await picture(control);
      expect(card.textContent).toContain("You're in control");
      const canvas = card.querySelector("canvas") as HTMLCanvasElement;
      canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 200 }) as DOMRect;
      await act(async () => {
        fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50, button: 0 });
        fireEvent.pointerUp(canvas, { clientX: 50, clientY: 50, button: 0 });
      });
      const stage = screen().getByRole("application", { name: "Pixel 8's screen, live" });
      await act(async () => {
        fireEvent.keyDown(stage, { key: "a" });
        fireEvent.keyDown(stage, { key: "Enter" });
      });
      await click(within(card).getByRole("button", { name: "Home" }));
      expect(control.sent).toEqual([
        { type: "ack" },
        { type: "tap", x: 0.5, y: 0.25 },
        { type: "text", text: "a" },
        { type: "key", key: "enter" },
        { type: "key", key: "home" },
      ]);
      await click(within(card).getByRole("button", { name: "Give back" }));
      expect(control.closed).toBe(true);
      expect(screens().at(-1)?.url).toContain("mode=watch");
    } finally {
      globalThis.createImageBitmap = drawn;
    }
  });

  test("an iPhone follows its Mac", async () => {
    await open(`/org/${ORG_ID}/settings/devices/phones/${IPHONE}`);
    expect(document.querySelector(".settings-rows")?.textContent).toContain("Same as Sam's MacBook Pro");
  });

  test("an admin on someone's computer may only narrow who can use it", async () => {
    await open(`/org/${ORG_ID}/settings/devices/${IMAC}`);
    const select = screen().getByRole("combobox", { name: "Who can use it" });
    await act(async () => {
      fireEvent.pointerDown(select, { button: 0, pointerType: "mouse" });
      fireEvent.keyDown(select, { key: "Enter" });
    });
    await settle(2);
    const options = screen().getAllByRole("option");
    const disabled = options.filter((o) => o.getAttribute("aria-disabled") === "true").map((o) => o.textContent);
    expect(disabled).toEqual(["Everyone in the workspace", "Only some people or roles"]);
  });
});

describe("In the chat and the inbox", () => {
  test("an agent waiting for a device: Try now, another device, Stop waiting; once it's back, an ended pill", async () => {
    const state = acmeState();
    state.messages.push({
      id: "m-wait",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: LIA },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "run-1",
      createdAt: new Date().toISOString(),
      meta: {
        deviceWait: {
          runId: "run-1",
          agentId: LIA,
          device: {
            kind: "phone",
            id: "p-ana-iphone",
            name: "Ana's iPhone 15",
            platform: "ios",
            hostId: "m-imac",
            hostName: "Ana's iMac",
            ownerUserId: "u-ana",
          },
          deviceName: "Ana's iPhone 15",
          hostName: "Ana's iMac",
          reason: "offline",
          detail: null,
          lastSeenAt: new Date(Date.now() - 18 * 60_000).toISOString(),
          state: "waiting",
        },
      },
    } as never);
    const { sockets } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, undefined, state);
    await act(async () => sockets.last().open());
    const card = document.querySelector(".rq-open") as HTMLElement;
    expect(card.textContent).toContain("Waiting for Ana's iPhone 15");
    expect(card.textContent).toContain("Ana's iMac is offline");
    await click(within(card).getByRole("button", { name: "Try now" }));
    expect(calls(state, "devices.deviceWait")[0]?.args).toEqual([ORG_ID, "run-1", "retry"]);
    await click(within(card).getByRole("button", { name: "Stop waiting" }));
    expect(calls(state, "devices.deviceWait")[1]?.args).toEqual([ORG_ID, "run-1", "stop"]);
    // The server ends the wait and says so on the channel: the card flips without a reload.
    await act(async () =>
      sockets.last().push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "device_wait.updated",
          channelId: ENG_ID,
          threadId: null,
          messageId: "m-wait",
          deviceWait: { deviceName: "Ana's iPhone 15", reason: "offline", state: "back" },
        },
      }),
    );
    await settle(4);
    expect(document.querySelector(".rq-done")?.textContent).toContain("Ana's iPhone 15 is back");
  });

  test("someone's agent asks for my phone: Allow once, Always or No, in the inbox", async () => {
    const state = acmeState();
    state.notifications = [
      notification({
        id: "n-dev",
        kind: "device.access_request" as never,
        waiting: true,
        actors: [{ type: "agent", id: LIA }],
        source: { requestId: "ar-1", phoneId: IPHONE, label: "Sam's iPhone 16", userId: RUI, runId: "run-2" } as never,
        latest: { title: "Rui", text: "Record the checkout" },
      }),
    ];
    await open(`/org/${ORG_ID}/notifications`, undefined, state);
    const row = document.querySelector('[data-n="n-dev"]') as HTMLElement;
    expect(row.textContent).toContain("Lia (for Rui) asks to use Sam's iPhone 16");
    expect(row.textContent).toContain("Devices");
    await click(within(row).getByRole("button", { name: "Allow once" }));
    expect(calls(state, "devices.decideAccess")[0]?.args).toEqual([ORG_ID, "ar-1", "once"]);
  });
});
