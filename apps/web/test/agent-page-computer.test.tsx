import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ComputerSetup, DesktopStatus, Machine } from "@agenteschat/client";
import { cleanup, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeBrowserOf, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

interface Options {
  setup?: Partial<ComputerSetup>;
  machine?: Partial<Machine> | null;
  desktop?: Partial<DesktopStatus>;
  role?: "owner" | "admin" | "member";
  standing?: "hold";
}

/** Ada's page for Walter (an owner unless `role` says), and the entry's row on it. */
async function entryOf(o: Options = {}) {
  const state = seedState();
  const org = state.me?.organizations[0];
  if (org && o.role) org.role = o.role;
  if (org && o.standing) org.standing = { state: o.standing, reason: null };
  const api = createFakeApi(state);
  const fake = fakeBrowserOf.get(api);
  const machines = fakeMachinesOf.get(api);
  if (!fake || !machines) throw new Error("no fakes");
  if (o.setup) machines.setSetup(o.setup);
  if (o.machine !== null) {
    const m = machines.pair({ name: "Mac mini", os: "darwin", ...o.machine });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
  }
  fake.desktops.set(ADA_ID, o.desktop ?? { available: true, reason: null, running: true });
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api });
  await settle(10);
  return screen().queryByRole("region", { name: "Computador da Ada" });
}

const line = (row: HTMLElement | null) => row?.querySelector(".cmp-entry__line")?.textContent ?? null;

describe("the agent page's one entry: its status line", () => {
  test("Cloud, its computer on its way: the time left, almost ready, or nothing said yet", async () => {
    const at = (secondsLeft: number | null) => ({
      step: "installing" as const,
      secondsLeft,
      expectedReadyAt: secondsLeft === null ? null : new Date(Date.now() + secondsLeft * 1000).toISOString(),
    });
    expect(line(await entryOf({ setup: at(330), machine: null }))).toBe("Sendo preparado · faltam uns 6 min");
    cleanup();
    expect(line(await entryOf({ setup: at(50), machine: null }))).toBe("Sendo preparado · quase pronto");
    cleanup();
    expect(line(await entryOf({ setup: at(null), machine: null }))).toBe("Sendo preparado");
  });

  test("Cloud, taking longer: owners are promised the email when the server sends it; nobody else is", async () => {
    const slow = { state: "waiting" as const, reason: "capacity" as const, notifyByEmail: true };
    expect(line(await entryOf({ setup: slow, machine: null }))).toBe(
      "Demorando mais que o normal · avisamos por e-mail",
    );
    cleanup();
    expect(line(await entryOf({ setup: slow, machine: null, role: "admin" }))).toBe("Demorando mais que o normal");
    cleanup();
    expect(line(await entryOf({ setup: { ...slow, notifyByEmail: false }, machine: null }))).toBe(
      "Demorando mais que o normal",
    );
    cleanup();
    expect(line(await entryOf({ setup: { state: "problem" }, machine: null }))).toBe(
      "Problema ao preparar · já estamos cuidando",
    );
  });

  test("a hold wins over the wait: paused for now, never a countdown", async () => {
    const row = await entryOf({
      setup: { secondsLeft: 330, expectedReadyAt: new Date(Date.now() + 330_000).toISOString() },
      machine: null,
      standing: "hold",
    });
    expect(line(row)).toBe("Em pausa por enquanto");
    cleanup();
    expect(line(await entryOf({ desktop: { available: true, reason: null, held: true } }))).toBe(
      "Em pausa por enquanto",
    );
  });

  test("its computer not answering (Cloud) or offline since a time (self-host)", async () => {
    const down = { desktop: { available: false, reason: "offline" } };
    const cloud = await entryOf({
      ...down,
      setup: { state: "ready" },
      machine: { name: "Computador da Acme", kind: "managed", os: "other", online: false },
    });
    expect(line(cloud)).toBe("Sem resposta · já estamos cuidando");
    cleanup();
    const seen = new Date(Date.now() - 20 * 60_000);
    const selfhost = await entryOf({ ...down, machine: { online: false, lastSeenAt: seen.toISOString() } });
    expect(line(selfhost)).toMatch(/^Offline desde \d\d:\d\d$/);
  });

  test("self-host: paused on the computer itself, until when", async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect(line(await entryOf({ machine: { paused: { until } } }))).toMatch(/^Pausado no Mac mini até \d\d:\d\d$/);
  });

  test("why nothing shows: uses neither, can't show; and no computer yet, with a picker", async () => {
    expect(line(await entryOf({ desktop: { available: false, reason: "no_desktop" } }))).toBe(
      "Não usa tela nem navegador",
    );
    cleanup();
    const row = await entryOf({ machine: null, desktop: { available: false, reason: "no_computer" } });
    expect(line(row)).toBe("Sem computador ainda");
    expect(within(row as HTMLElement).getByRole("button", { name: "Escolher um computador" })).toBeTruthy();
    cleanup();
    expect(line(await entryOf())).toBe("Disponível · ninguém usando agora");
  });
});
