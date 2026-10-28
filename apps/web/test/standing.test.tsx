import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type OrgStanding, type Role } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setNavigateAway } from "@/lib/navigate";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const STATUS = "Status do workspace";
const OTHER_ID = "00000000-0000-4000-8000-0000000000b2";

/** #eng of Acme with the standing `/me` says, and its socket open to push what the operator changes. */
async function open(
  standing?: OrgStanding,
  other = false,
  supportEmail: string | null = null,
  {
    role = "owner",
    billingUrl = null,
    state = seedState(),
    cloud = false,
  }: { role?: Role; billingUrl?: string | null; state?: ReturnType<typeof seedState>; cloud?: boolean } = {},
) {
  state.authConfig = { ...state.authConfig, supportEmail, billingUrl, ...(cloud ? { workspaceComputer: true } : {}) };
  if (state.me) {
    state.me.organizations = [
      { id: ORG_ID, name: "Acme", role, ...(standing ? { standing } : {}) },
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
  return { ...r, state, set, channel };
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

  test("on the Cloud with no address: no line, since nobody else runs that server; with one, where to write", async () => {
    await open({ state: "hold", reason: null }, false, null, { cloud: true });
    const banner = () => screen().getByRole("region", { name: STATUS });
    expect(banner().textContent).toContain("Os agentes deste workspace estão pausados para uma revisão.");
    expect(banner().textContent).not.toContain("Precisa de ajuda");
    expect(banner().querySelector(".support-line")).toBeNull();
    cleanup();
    await open({ state: "suspended", reason: null }, false, null, { cloud: true });
    expect(document.body.textContent).toContain("As conversas e os agentes dele estão fechados por enquanto.");
    expect(document.body.textContent).not.toContain("Precisa de ajuda");
    cleanup();
    await open({ state: "hold", reason: null }, false, "suporte@agentes.chat", { cloud: true });
    expect(banner().textContent).toContain("Precisa de ajuda? Escreva para suporte@agentes.chat.");
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

describe("a billing hold (ADR 0077): its own words, and its fix for whoever runs the workspace", () => {
  const BILLING = "https://billing.example.com";

  test("owners and admins get the button of its code: it opens the billing service, signed in", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { state, set } = await open({ state: "hold", reason: "payment" }, false, null, { billingUrl: BILLING });
    const banner = () => screen().getByRole("region", { name: STATUS });
    expect(banner().textContent).toContain(
      "Este workspace ainda não tem um plano do agentes.chat. Os agentes começam a trabalhar quando ele tiver.",
    );
    expect(banner().textContent).toContain(
      "Dá para ler e escrever aqui. Os agentes voltam quando o plano do agentes.chat estiver em dia.",
    );
    expect(banner().textContent).not.toContain("payment");
    await act(async () =>
      fireEvent.click(within(banner()).getByRole("button", { name: "Ver planos do agentes.chat" })),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.billingLink")?.args).toEqual([ORG_ID, "hold"]);
    expect(left).toEqual(["https://billing.example.com/link?t=hold"]);

    await set({ state: "hold", reason: "unpaid" });
    expect(within(banner()).getByRole("button", { name: "Atualizar o pagamento" })).toBeTruthy();
    await set({ state: "hold", reason: "ended" });
    expect(banner().textContent).toContain("O plano do agentes.chat deste workspace terminou, e os agentes pararam.");
    expect(within(banner()).getByRole("button", { name: "Assinar de novo" })).toBeTruthy();
  });

  test("a link that can't be made says so; members read who can fix it, with no button", async () => {
    const state = seedState();
    state.billingLinkError = new ApiError(500, "internal_error", "Something went wrong on our side");
    await open({ state: "hold", reason: "unpaid" }, false, null, { billingUrl: BILLING, state });
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Atualizar o pagamento" })));
    await settle(4);
    expect(document.body.textContent).toContain("Não deu para abrir agora. Tente de novo em instantes.");

    cleanup();
    await open({ state: "hold", reason: "unpaid" }, false, null, { billingUrl: BILLING, role: "member" });
    const banner = screen().getByRole("region", { name: STATUS });
    expect(banner.textContent).toContain("Quem administra o workspace pode resolver isso.");
    expect(within(banner).queryByRole("button")).toBeNull();
  });

  test("a refused run says the hold's words, never its code", async () => {
    const { channel } = await open({ state: "hold", reason: "payment" }, false, null, { billingUrl: BILLING });
    const run = { threadId: null, runId: "r-billing", agentId: ADA_ID };
    await channel({ type: "agent.thinking", ...run });
    await channel({
      type: "run.finished",
      ...run,
      status: "failed",
      error: "This workspace is on hold: payment",
      errorCode: "run.org_paused",
      errorParams: { reason: "payment" },
    });
    expect(screen().getByRole("alert").textContent).toBe(
      "Ada não respondeu. Este workspace ainda não tem um plano do agentes.chat. Os agentes começam a trabalhar quando ele tiver.",
    );
  });

  test("an invitation to a workspace on one says the hold's words, never its code", async () => {
    const state = seedState({ previews: { held: { orgName: "Acme", email: "walter@acme.com.br", role: "member" } } });
    const api = createFakeApi(state);
    api.orgs.acceptInvitation = async () => {
      throw new ApiError(403, "org.paused", "This workspace is on hold: unpaid", { reason: "unpaid" });
    };
    await renderApp("/invite/held", { api });
    await settle(4);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Aceitar e entrar na Acme" })));
    await settle(4);
    expect(screen().getByRole("alert").textContent).toBe(
      "O pagamento do plano do agentes.chat deste workspace não passou, e os agentes pararam.",
    );
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
