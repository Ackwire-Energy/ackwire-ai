import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { OrgStanding } from "@agenteschat/client";
import { act, cleanup, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const STATUS = "Status do workspace";
const OTHER_ID = "00000000-0000-4000-8000-0000000000b2";

/** #eng of Acme with the standing `/me` says, and its socket open to push what the operator changes. */
async function open(standing?: OrgStanding, other = false, supportEmail: string | null = null) {
  const state = seedState();
  state.authConfig = { ...state.authConfig, supportEmail };
  if (state.me) {
    state.me.organizations = [
      { id: ORG_ID, name: "Acme", role: "owner", ...(standing ? { standing } : {}) },
      ...(other ? [{ id: OTHER_ID, name: "Beta", role: "member" as const }] : []),
    ];
  }
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  const set = async (next: OrgStanding) => {
    await act(async () =>
      socket.push({ type: "event", scope: "org", event: { type: "org.standing", orgId: ORG_ID, ...next } }),
    );
    await settle(6);
  };
  const channel = async (event: Record<string, unknown>) => {
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    await settle(4);
  };
  return { ...r, set, channel };
}

describe("on hold: a line on top of the work area", () => {
  test("the reason when the workspace is told one, only 'paused for review' when not; gone once active", async () => {
    const { set } = await open({ state: "hold", reason: "verificação de pagamento" });
    const banner = () => screen().getByRole("region", { name: STATUS });
    expect(banner().textContent).toContain("Este workspace está em espera: verificação de pagamento");
    expect(banner().textContent).toContain(
      "Dá para ler e escrever normalmente; os agentes não respondem nem trabalham enquanto ele estiver em espera.",
    );
    // Where to ask: nobody named on this server, so whoever runs it.
    expect(banner().textContent).toContain("Precisa de ajuda? Fale com quem cuida deste servidor.");
    // People still read and write: the chat is there under it.
    expect(screen().getByRole("combobox", { name: "Mensagem para #eng" })).toBeTruthy();

    await set({ state: "hold", reason: null });
    expect(banner().textContent).toContain("Os agentes deste workspace estão pausados para uma revisão.");
    expect(banner().textContent).not.toContain("pagamento");

    await set({ state: "active", reason: null });
    expect(screen().queryByRole("region", { name: STATUS })).toBeNull();
  });

  test("where to write when the server names an address", async () => {
    await open({ state: "hold", reason: null }, false, "ajuda@acme.test");
    const banner = screen().getByRole("region", { name: STATUS });
    expect(banner.textContent).toContain("Precisa de ajuda? Escreva para ajuda@acme.test.");
    expect(within(banner).getByRole("link", { name: "ajuda@acme.test" }).getAttribute("href")).toBe(
      "mailto:ajuda@acme.test",
    );
  });

  test("an active workspace shows nothing", async () => {
    await open({ state: "active", reason: null });
    expect(screen().queryByRole("region", { name: STATUS })).toBeNull();
    await cleanup();
    await open();
    expect(screen().queryByRole("region", { name: STATUS })).toBeNull();
  });

  test("a run refused by the standing says so plainly, in the person's language", async () => {
    const { channel } = await open({ state: "hold", reason: "verificação de pagamento" });
    const run = { threadId: null, runId: "r-held", agentId: ADA_ID };
    await channel({ type: "agent.thinking", ...run });
    await channel({
      type: "run.finished",
      ...run,
      status: "failed",
      error: "This workspace is on hold: verificação de pagamento",
      errorCode: "run.org_paused",
      errorParams: { reason: "verificação de pagamento" },
    });
    const alert = screen().getByRole("alert");
    expect(alert.textContent).toBe("Ada não respondeu. Este workspace está em espera: verificação de pagamento");
    expect(document.body.textContent).not.toContain("This workspace is on hold");
  });
});

describe("suspended: a screen of its own", () => {
  test("opening a suspended workspace shows the screen at once", async () => {
    await open({ state: "suspended", reason: null });
    expect(screen().getByRole("heading", { name: "Este workspace está indisponível" })).toBeTruthy();
    expect(document.body.textContent).toContain("As conversas e os agentes dele estão fechados por enquanto.");
    expect(document.body.textContent).toContain("Precisa de ajuda? Fale com quem cuida deste servidor.");
    expect(screen().queryByRole("combobox", { name: "Mensagem para #eng" })).toBeNull();
  });

  test("in place of the shell, live: why when told, where to ask, the other workspaces, Sair; back once lifted", async () => {
    const { set } = await open(undefined, true, "ajuda@acme.test");
    expect(screen().queryByRole("heading", { name: "Este workspace está indisponível" })).toBeNull();

    await set({ state: "suspended", reason: "uso fora dos termos" });
    expect(screen().getByRole("heading", { name: "Este workspace está indisponível" })).toBeTruthy();
    expect(document.body.textContent).toContain("Este workspace está suspenso: uso fora dos termos");
    expect(screen().getByRole("link", { name: "ajuda@acme.test" }).getAttribute("href")).toBe("mailto:ajuda@acme.test");
    // No sidebar, no chat: nothing of the workspace is open.
    expect(screen().queryByRole("combobox", { name: "Mensagem para #eng" })).toBeNull();
    const others = screen().getByRole("navigation", { name: "Seus outros workspaces" });
    expect(within(others).getByRole("link", { name: "Beta" }).getAttribute("href")).toBe(`/org/${OTHER_ID}`);
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();

    // Silent: only that it is unavailable.
    await set({ state: "suspended", reason: null });
    expect(document.body.textContent).toContain("As conversas e os agentes dele estão fechados por enquanto.");
    expect(document.body.textContent).not.toContain("uso fora dos termos");

    await set({ state: "active", reason: null });
    expect(screen().queryByRole("heading", { name: "Este workspace está indisponível" })).toBeNull();
    expect(screen().getByRole("combobox", { name: "Mensagem para #eng" })).toBeTruthy();
  });
});
