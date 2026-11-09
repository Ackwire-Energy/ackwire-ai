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
    expect(dialog.querySelector(".dv-path")?.textContent).toBe("SettingsPrivacy & SecurityDeveloper Mode");
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
