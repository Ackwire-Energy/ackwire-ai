import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ADMIN_ROLE_ID, createFakeApi, ENG_ID, fakeDashboardsOf, NOW, ORG_ID, seedState } from "./fake-api";
import type { FakeDashboards } from "./fakes/dashboards";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const tab = (dialog: HTMLElement, name: string) =>
  act(async () => fireEvent.mouseDown(within(dialog).getByRole("tab", { name }), { button: 0 }));

const open = async (path: string, prepare?: (fake: FakeDashboards) => void) => {
  const state = seedState();
  const api = createFakeApi(state);
  const fake = fakeDashboardsOf.get(api) as FakeDashboards;
  prepare?.(fake);
  const view = await renderApp(path, { api });
  await settle(8);
  return { state, fake, router: view.router, services: view.services };
};
const callOf = (state: { calls: { method: string; args: unknown[] }[] }, method: string) =>
  state.calls.find((c) => c.method === method);
const callsOf = (state: { calls: { method: string; args: unknown[] }[] }, method: string) =>
  state.calls.filter((c) => c.method === method);
/** One choice of a radio group (a segmented control, the blocks to pin) by the group's name. */
const segment = (dialog: HTMLElement, group: string, name: string | RegExp) =>
  within(within(dialog).getByRole("radiogroup", { name: group })).getByRole("radio", { name });
const myBoard = (fake: FakeDashboards) =>
  fake.addBoard({ id: "dash-m", title: "Metas", owner: { kind: "person", id: "u-walter", name: "Walter" } });

describe("New dashboard (ADR 0134 §8, §10)", () => {
  const start = async () => {
    const opened = await open(`/org/${ORG_ID}/dashboards`);
    await click(screen().getAllByRole("button", { name: "Novo painel" })[0] as Element);
    await settle(4);
    return { ...opened, dialog: screen().getByRole("dialog", { name: "Novo painel" }) };
  };

  test("blank and only for me by default: Create dashboard makes it and opens it", async () => {
    const { state, router, dialog } = await start();
    const create = within(dialog).getByRole("button", { name: "Criar painel" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(within(dialog).getByRole("radio", { name: /^Só você/ }).getAttribute("aria-checked")).toBe("true");
    // What whoever sees it sees, said where the audience is chosen (ADR 0134 §12).
    expect(dialog.textContent).toContain("Quem vê o painel vê o que os agentes trouxeram");
    await type(within(dialog).getByLabelText("Nome"), "Metas do trimestre");
    await click(create);
    await settle(6);
    expect(callOf(state, "dashboards.create")?.args[1]).toEqual({
      title: "Metas do trimestre",
      audience: "private",
      roleIds: [],
      editPolicy: "owner",
    });
    expect(router.state.location.pathname).toMatch(new RegExp(`^/org/${ORG_ID}/dashboards/.+`));
    expect(screen().getByRole("heading", { name: "Metas do trimestre", level: 1 })).toBeTruthy();
    expect(screen().getByText("“Metas do trimestre” criado")).toBeTruthy();
  });

  test("for roles: each role with its people; at least one before it can be made", async () => {
    const { state, dialog } = await start();
    await type(within(dialog).getByLabelText("Nome"), "Diretoria");
    await click(within(dialog).getByRole("radio", { name: /^Papéis/ }));
    await settle(2);
    const chips = within(dialog).getByRole("group", { name: "Papéis" });
    const admin = within(chips).getByRole("button", { name: /^Admin/ });
    expect(admin.getAttribute("aria-pressed")).toBe("false");
    const create = within(dialog).getByRole("button", { name: "Criar painel" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await click(admin);
    await click(within(dialog).getByRole("radio", { name: "Quem vê" }));
    expect(create.disabled).toBe(false);
    await click(create);
    await settle(6);
    expect(callOf(state, "dashboards.create")?.args[1]).toEqual({
      title: "Diretoria",
      audience: "roles",
      roleIds: [ADMIN_ROLE_ID],
      editPolicy: "viewers",
    });
  });

  test("asking an agent: the brief goes to its DM, where it builds the widgets", async () => {
    const { state, dialog } = await start();
    await type(within(dialog).getByLabelText("Nome"), "Black Friday");
    await click(within(dialog).getByRole("radio", { name: /^Pedir a um agente/ }));
    await settle(2);
    const agents = within(dialog).getByRole("group", { name: "Quem cuida" });
    expect(within(agents).getByRole("button", { name: "Ada" }).getAttribute("aria-pressed")).toBe("true");
    const create = within(dialog).getByRole("button", { name: "Criar painel" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await type(within(dialog).getByLabelText("O que Ada deve montar"), "Vendas e estoque da semana");
    await click(create);
    await settle(6);
    expect(callOf(state, "dashboards.create")?.args[1]).toMatchObject({
      title: "Black Friday",
      start: { agentId: ADA_ID, brief: "Vendas e estoque da semana" },
    });
    expect(screen().getByText("Ada está montando “Black Friday” na conversa com você")).toBeTruthy();
    expect(screen().getByRole("button", { name: "Abrir a conversa" })).toBeTruthy();
  });
});

describe("Share (ADR 0134 §8, §12)", () => {
  test("who has access follows the choice on screen; Save sends it", async () => {
    const { state } = await open(`/org/${ORG_ID}/dashboards/dash-m`, myBoard);
    await click(screen().getByRole("button", { name: "Compartilhar" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Compartilhar “Metas”" });
    const people = () => within(dialog).getByRole("list", { name: "Quem tem acesso" });
    const row = (name: RegExp) =>
      within(people())
        .getAllByRole("listitem")
        .find((li) => name.test(li.textContent ?? "")) as HTMLElement;
    expect(row(/Walter \(você\)/).textContent).toContain("Edita");
    expect(row(/João/).textContent).toContain("Não vê");
    await click(within(dialog).getByRole("radio", { name: /^Todo o workspace/ }));
    await settle(2);
    // João holds Admin: admins see every board but private ones, and edit what they see.
    expect(row(/João/).textContent).toContain("Edita");
    expect(row(/João/).textContent).toContain("Admin");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(callOf(state, "dashboards.share")?.args).toEqual([
      ORG_ID,
      "dash-m",
      { audience: "workspace", roleIds: [], editPolicy: "owner" },
    ]);
    expect(screen().getByText("“Metas” agora é do workspace")).toBeTruthy();
    expect((document.querySelector(".db-meta") as HTMLElement).textContent).toContain("Todo o workspace");
  });
});

describe("New widget (ADR 0134 §3)", () => {
  const withSuggestions = (fake: FakeDashboards) => {
    myBoard(fake);
    fake.suggestions.set(ADA_ID, {
      agentId: ADA_ID,
      sources: ["GitHub", "Sentry"],
      suggestions: [
        {
          title: "PRs esperando revisão",
          prompt: "Os PRs que esperam revisão há mais de um dia",
          kind: "list",
          alert: "algum esperar mais de 2 dias",
        },
      ],
    });
  };
  const start = async (prepare: (fake: FakeDashboards) => void = withSuggestions) => {
    const opened = await open(`/org/${ORG_ID}/dashboards/dash-m`, prepare);
    await click(screen().getAllByRole("button", { name: "Adicionar widget" })[0] as Element);
    await settle(6);
    return { ...opened, dialog: screen().getByRole("dialog", { name: "Novo widget" }) };
  };

  const button = (dialog: HTMLElement, name: string) => within(dialog).queryByRole("button", { name });
  const preview = (dialog: HTMLElement) => within(dialog).getByRole("complementary", { name: "Prévia" });

  test("who and the format are dropdowns; a suggestion fills the ask; preview, steps and cost follow", async () => {
    const { dialog } = await start();
    // Nothing asked yet: the preview says what it will show, and there is nothing to test.
    expect(dialog.textContent).toContain("Diga o que quer acompanhar e Ada mostra aqui como vai ficar.");
    expect((button(dialog, "Testar") as HTMLButtonElement).disabled).toBe(true);
    expect(button(dialog, "Criar widget")).toBeNull();

    // Who looks after it: Ada's face and name; in the list, her role under her name (what she reads is in the steps).
    const who = within(dialog).getByRole("combobox", { name: "Quem cuida" });
    expect(who.textContent).toContain("Ada");
    who.focus();
    await act(async () => fireEvent.keyDown(who, { key: "Enter" }));
    const ada = screen().getByRole("option", { name: /^Ada/ });
    expect(ada.textContent).toContain("Dev");
    expect(ada.textContent).not.toContain("lê");
    expect(ada.querySelector(".ac-avatar")).toBeTruthy();
    await click(ada);
    await settle(2);
    // The format: Automatic first, each with what it shows.
    const format = within(dialog).getByRole("combobox", { name: "Formato" });
    expect(format.textContent).toContain("Automático");
    format.focus();
    await act(async () => fireEvent.keyDown(format, { key: "Enter" }));
    const formats = screen().getAllByRole("option");
    expect(formats[0]?.textContent).toContain("Ada escolhe o que mostra melhor");
    expect(formats.some((o) => o.textContent?.includes("Um número grande e como ele mudou"))).toBe(true);
    await click(formats[0] as HTMLElement);
    await settle(2);

    await click(within(dialog).getByRole("button", { name: "PRs esperando revisão" }));
    await settle(3);
    expect((within(dialog).getByLabelText("O que você quer acompanhar?") as HTMLTextAreaElement).value).toBe(
      "Os PRs que esperam revisão há mais de um dia",
    );
    expect((within(dialog).getByLabelText("Avisar se") as HTMLInputElement).value).toBe(
      "algum esperar mais de 2 dias",
    );
    const pane = preview(dialog);
    expect(within(pane).getByRole("article", { name: "PRs esperando revisão" })).toBeTruthy();
    expect(pane.textContent).toContain("dados de exemplo");
    expect(pane.textContent).toContain("Teste antes para ver o resultado de verdade");
    expect(pane.textContent).toContain("Ada monta agora, com os dados de verdade");
    expect(pane.textContent).toContain("Lê GitHub e Sentry");
    expect(pane.textContent).toContain("Cria a rotina “PRs esperando revisão”");
    expect(pane.textContent).toContain("A cada hora · aparece em Rotinas");
    expect(pane.textContent).toContain("Avisa em Esperando você se algum esperar mais de 2 dias");
    // 24 runs a day at the agent's recent cost per run.
    expect(pane.textContent).toMatch(/≈ US\$\s0,36 por dia do orçamento de Ada/);
    expect((button(dialog, "Testar") as HTMLButtonElement).disabled).toBe(false);
  });

  test("Test builds a draft with real data; Create widget puts it on the board, title as edited", async () => {
    const { state, fake, dialog } = await start();
    await click(within(dialog).getByRole("button", { name: "PRs esperando revisão" }));
    await pick(within(dialog).getByRole("combobox", { name: "Formato" }), /^Número/);
    await click(segment(dialog, "Atualiza", "Todo dia · 8h"));
    await click(segment(dialog, "Tamanho", "G"));
    await settle(3);
    expect(preview(dialog).textContent).toContain("Todo dia às 8h · aparece em Rotinas");

    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    expect(callOf(state, "dashboards.testWidget")?.args).toEqual([
      ORG_ID,
      "dash-m",
      {
        agentId: ADA_ID,
        prompt: "Os PRs que esperam revisão há mais de um dia",
        title: "PRs esperando revisão",
        format: "kpi",
        schedule: "day",
        alert: { enabled: true, condition: "algum esperar mais de 2 dias" },
        size: "l",
      },
    ]);
    // The draft, built with real data: on no board, shown in the preview with what the test cost.
    const draftId = fake.drafts[0]?.id as string;
    expect(fake.drafts).toHaveLength(1);
    const pane = preview(dialog);
    expect(pane.textContent).toContain("Dados de verdade · agora");
    expect(pane.textContent).not.toContain("dados de exemplo");
    expect(pane.textContent).toMatch(/Este teste custou US\$\s0,01/);
    expect(within(pane).getByRole("article", { name: "PRs esperando revisão" }).querySelector(".wk-num")).toBeTruthy();
    expect(button(dialog, "Testar")).toBeNull();
    expect(button(dialog, "Testar de novo")).toBeTruthy();

    // Its title, the agent's, can be changed before it is created; the schedule changes without a new test.
    const title = within(dialog).getByLabelText("Título") as HTMLInputElement;
    expect(title.value).toBe("PRs esperando revisão");
    await type(title, "PRs parados");
    await click(segment(dialog, "Atualiza", "A cada hora"));
    await settle(2);
    expect(within(pane).getByRole("article", { name: "PRs parados" })).toBeTruthy();
    await click(button(dialog, "Criar widget") as HTMLElement);
    await settle(6);
    expect(callOf(state, "dashboards.confirmWidget")?.args).toEqual([
      ORG_ID,
      draftId,
      {
        dashboardId: "dash-m",
        title: "PRs parados",
        size: "l",
        schedule: "hour",
        alert: { enabled: true, condition: "algum esperar mais de 2 dias" },
      },
    ]);
    // Created: kept (not deleted with the dialog), on the board, and the dialog closed.
    expect(callOf(state, "dashboards.removeWidget")).toBeUndefined();
    expect(callOf(state, "dashboards.createWidget")).toBeUndefined();
    expect(screen().getByText("Widget adicionado em Metas")).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Novo widget" })).toBeNull();
    expect(screen().getByRole("article", { name: "PRs parados" })).toBeTruthy();
  });

  test("the agent's title is kept when nobody edits it; no title is sent", async () => {
    const { state, dialog } = await start();
    await type(within(dialog).getByLabelText("O que você quer acompanhar?"), "erros em produção hoje");
    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    expect((within(dialog).getByLabelText("Título") as HTMLInputElement).value).toBe("Erros em produção hoje");
    await click(button(dialog, "Criar widget") as HTMLElement);
    await settle(6);
    const sent = callOf(state, "dashboards.confirmWidget")?.args[2] as Record<string, unknown>;
    expect(sent).toEqual({
      dashboardId: "dash-m",
      size: "m",
      schedule: "hour",
      alert: { enabled: true, condition: "" },
    });
  });

  test("while it builds: the agent at it, Test waits; then the real result and Create widget", async () => {
    const { fake, services, dialog } = await start((fake) => {
      withSuggestions(fake);
      fake.holdDrafts = true;
    });
    await type(within(dialog).getByLabelText("O que você quer acompanhar?"), "erros em produção hoje");
    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    const pane = preview(dialog);
    expect(pane.textContent).toContain("Ada está montando com os dados de verdade…");
    expect((button(dialog, "Testar") as HTMLButtonElement).disabled).toBe(true);
    expect(button(dialog, "Criar widget")).toBeNull();
    // Its name, while the agent hasn't named it: the format's, never the ask.
    expect(within(pane).getByRole("article", { name: "Novo widget" })).toBeTruthy();

    const draftId = fake.drafts[0]?.id as string;
    fake.finish(draftId, {
      spec: { kind: "kpi", value: 3, note: "desde as 8h" },
      title: "Erros hoje",
    });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    expect(pane.textContent).toContain("Dados de verdade");
    expect(within(pane).getByRole("article", { name: "Erros hoje" })).toBeTruthy();
    expect(button(dialog, "Criar widget")).toBeTruthy();
  });

  test("a changed ask or format makes the test stale; a new test drops the old draft", async () => {
    const { state, fake, dialog } = await start();
    const ask = within(dialog).getByLabelText("O que você quer acompanhar?");
    await type(ask, "erros em produção hoje");
    await click(segment(dialog, "Atualiza", "Quando eu pedir"));
    await click(within(dialog).getByRole("switch", { name: "Me avisar quando algo fugir do normal" }));
    await settle(3);
    const pane = preview(dialog);
    expect(pane.textContent).toContain("Sem rotina: atualiza quando você pedir");
    expect(pane.textContent).toContain("Só gasta quando você pede para atualizar");
    expect(pane.textContent).toContain("Sem avisos");
    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    expect(callOf(state, "dashboards.testWidget")?.args[2]).toEqual({
      agentId: ADA_ID,
      prompt: "erros em produção hoje",
      format: "auto",
      schedule: "manual",
      alert: { enabled: false, condition: "" },
      size: "m",
    });
    const first = fake.drafts[0]?.id as string;
    expect(button(dialog, "Criar widget")).toBeTruthy();

    // The size and the alert don't touch the test; the ask does.
    await click(segment(dialog, "Tamanho", "P"));
    await settle(2);
    expect(button(dialog, "Criar widget")).toBeTruthy();
    await type(ask, "erros em produção desta semana");
    await settle(2);
    expect(pane.textContent).toContain("Mudou desde o teste");
    expect(pane.textContent).toContain("Teste antes para ver o resultado de verdade");
    expect(button(dialog, "Criar widget")).toBeNull();
    // Back as it was tested: the test holds again.
    await type(ask, "erros em produção hoje");
    await settle(2);
    expect(button(dialog, "Criar widget")).toBeTruthy();
    // The format too.
    await pick(within(dialog).getByRole("combobox", { name: "Formato" }), /^Lista/);
    expect(pane.textContent).toContain("Mudou desde o teste");

    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    expect(callsOf(state, "dashboards.testWidget")).toHaveLength(2);
    expect(callsOf(state, "dashboards.removeWidget").map((c) => c.args)).toEqual([[ORG_ID, first]]);
    expect(fake.drafts.map((d) => d.id)).not.toContain(first);
    expect(button(dialog, "Criar widget")).toBeTruthy();
  });

  test("a test that fails says why, with Try again; closing the dialog drops the draft", async () => {
    const { state, fake, dialog } = await start();
    await type(within(dialog).getByLabelText("O que você quer acompanhar?"), "status do failover");
    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    const pane = preview(dialog);
    expect(pane.textContent).toContain("Não deu certo: The source isn't connected for me.");
    expect(button(dialog, "Criar widget")).toBeNull();
    const first = fake.drafts[0]?.id as string;
    await click(within(pane).getByRole("button", { name: "Tentar de novo" }));
    await settle(6);
    expect(callsOf(state, "dashboards.testWidget")).toHaveLength(2);
    expect(callsOf(state, "dashboards.removeWidget").map((c) => c.args)).toEqual([[ORG_ID, first]]);
    const second = fake.drafts[0]?.id as string;
    expect(second).not.toBe(first);

    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await settle(6);
    expect(screen().queryByRole("dialog", { name: "Novo widget" })).toBeNull();
    expect(callsOf(state, "dashboards.removeWidget").map((c) => c.args)).toEqual([
      [ORG_ID, first],
      [ORG_ID, second],
    ]);
    expect(fake.drafts).toHaveLength(0);
  });

  test("pinning a chart from the chat: pick it, keep it updated or not, Pin", async () => {
    const { state, dialog } = await start((fake) => {
      myBoard(fake);
      fake.pinnable = [
        {
          messageId: "m-2",
          channelId: ENG_ID,
          threadId: null,
          agentId: ADA_ID,
          at: NOW.toISOString(),
          block: JSON.stringify({
            type: "bar",
            title: "Deploys da semana",
            labels: ["seg", "ter", "qua"],
            series: [{ name: "deploys", values: [3, 5, 2] }],
          }),
          title: "Deploys da semana",
          spec: { kind: "bars", labels: ["seg", "ter", "qua"], values: [3, 5, 2] },
          place: { kind: "channel", name: "eng" },
        },
      ];
    });
    await tab(dialog, "Fixar do chat");
    await settle(4);
    const pin = within(dialog).getByRole("button", { name: "Fixar" }) as HTMLButtonElement;
    expect(pin.disabled).toBe(true);
    expect(dialog.textContent).toContain("Escolha um bloco do chat.");
    const block = segment(dialog, "Blocos que os agentes mandaram no chat", /Deploys da semana/);
    expect(block.textContent).toContain("Ada em #eng");
    await click(block);
    await click(segment(dialog, "Manter atualizado", "Não, só fixar"));
    await settle(3);
    const preview = within(dialog).getByRole("complementary", { name: "Prévia" });
    expect(within(preview).getByRole("article", { name: "Deploys da semana" })).toBeTruthy();
    expect(preview.textContent).toContain("Fixa o bloco como está no chat");
    expect(preview.textContent).toContain("Não atualiza sozinho");
    await click(pin);
    await settle(6);
    const call = callOf(state, "dashboards.pinWidget");
    expect(call?.args[1]).toBe("dash-m");
    expect(call?.args[2]).toMatchObject({ messageId: "m-2", schedule: "manual", size: "m" });
  });
});
