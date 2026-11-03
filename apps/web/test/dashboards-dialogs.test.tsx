import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ADMIN_ROLE_ID, createFakeApi, ENG_ID, fakeDashboardsOf, NOW, ORG_ID, seedState } from "./fake-api";
import type { FakeDashboards } from "./fakes/dashboards";
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
  return { state, fake, router: view.router };
};
const callOf = (state: { calls: { method: string; args: unknown[] }[] }, method: string) =>
  state.calls.find((c) => c.method === method);
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

  test("asking an agent: a suggestion fills the ask and the alert; preview, steps and cost follow", async () => {
    const { state, dialog } = await start();
    // Nothing asked yet: the preview says what it will show.
    expect(dialog.textContent).toContain("Diga o que quer acompanhar e Ada mostra aqui como vai ficar.");
    const create = within(dialog).getByRole("button", { name: "Criar widget" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    // The agent that looks after it, with what it reads.
    const ada = within(within(dialog).getByRole("group", { name: "Quem cuida" })).getByRole("button", {
      name: /Ada/,
    });
    expect(ada.getAttribute("aria-pressed")).toBe("true");
    expect(ada.textContent).toContain("Dev · lê GitHub e Sentry");

    await click(within(dialog).getByRole("button", { name: "PRs esperando revisão" }));
    await settle(3);
    expect((within(dialog).getByLabelText("O que você quer acompanhar?") as HTMLTextAreaElement).value).toBe(
      "Os PRs que esperam revisão há mais de um dia",
    );
    expect((within(dialog).getByLabelText("Avisar se") as HTMLInputElement).value).toBe(
      "algum esperar mais de 2 dias",
    );
    const preview = within(dialog).getByRole("complementary", { name: "Prévia" });
    expect(within(preview).getByRole("article", { name: "PRs esperando revisão" })).toBeTruthy();
    expect(preview.textContent).toContain("dados de exemplo");
    expect(preview.textContent).toContain("Ada monta agora, com os dados de verdade");
    expect(preview.textContent).toContain("Lê GitHub e Sentry");
    expect(preview.textContent).toContain("Cria a rotina “PRs esperando revisão”");
    expect(preview.textContent).toContain("A cada hora · aparece em Rotinas");
    expect(preview.textContent).toContain("Avisa em Esperando você se algum esperar mais de 2 dias");
    // 24 runs a day at the agent's recent cost per run.
    expect(preview.textContent).toMatch(/≈ US\$\s0,36 por dia do orçamento de Ada/);

    await click(within(dialog).getByRole("button", { name: "Número" }));
    await click(segment(dialog, "Atualiza", "Todo dia · 8h"));
    await click(segment(dialog, "Tamanho", "G"));
    await settle(3);
    expect(preview.textContent).toContain("Todo dia às 8h · aparece em Rotinas");
    expect(create.disabled).toBe(false);
    await click(create);
    await settle(6);
    expect(callOf(state, "dashboards.createWidget")?.args).toEqual([
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
    expect(screen().getByText("Widget adicionado em Metas")).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Novo widget" })).toBeNull();
  });

  test("only when asked: no routine, no cost; the alert can be turned off", async () => {
    const { state, dialog } = await start();
    await type(within(dialog).getByLabelText("O que você quer acompanhar?"), "erros em produção hoje");
    await click(segment(dialog, "Atualiza", "Quando eu pedir"));
    await click(within(dialog).getByRole("switch", { name: "Me avisar quando algo fugir do normal" }));
    await settle(3);
    const preview = within(dialog).getByRole("complementary", { name: "Prévia" });
    expect(preview.textContent).toContain("Sem rotina: atualiza quando você pedir");
    expect(preview.textContent).toContain("Só gasta quando você pede para atualizar");
    expect(preview.textContent).toContain("Sem avisos");
    await click(within(dialog).getByRole("button", { name: "Criar widget" }));
    await settle(6);
    expect(callOf(state, "dashboards.createWidget")?.args[2]).toEqual({
      agentId: ADA_ID,
      prompt: "erros em produção hoje",
      format: "auto",
      schedule: "manual",
      alert: { enabled: false, condition: "" },
      size: "m",
    });
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
