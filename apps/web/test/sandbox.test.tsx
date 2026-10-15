import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { AgentAccess } from "@/api/types";
import { isDomain } from "@/components/AgentComputer";
import { createI18n } from "@/i18n";
import { countTools, modelFrom, resolve, treeFromAccess } from "@/lib/access";
import { activityText, toolActivity } from "@/lib/activity";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await key(trigger, "Enter");
  return screen().getByRole("menu");
};

describe("Configurações → Sandbox", () => {
  const go = async (state = seedState()) => {
    await renderApp(`/org/${ORG_ID}/settings/sandbox`, { api: createFakeApi(state) });
    await settle(8);
    return state;
  };

  test("on/off, the internet allowlist with presets, limits and approval; saved explicitly", async () => {
    const state = await go();
    const card = within(screen().getByRole("region", { name: "PC dos agentes" }));
    expect(card.getByText("Sem internet.")).toBeTruthy();
    expect(screen().getByRole("region", { name: "PC dos agentes" }).textContent).toContain(
      "Por padrão, os PCs não acessam a internet.",
    );
    await type(card.getByLabelText("Adicionar domínio"), "não é domínio");
    await click(card.getByRole("button", { name: "Adicionar" }));
    expect(card.getByText("Use um domínio como api.exemplo.com ou *.exemplo.com.")).toBeTruthy();
    await type(card.getByLabelText("Adicionar domínio"), "*.github.com");
    await click(card.getByRole("button", { name: "Adicionar" }));
    await click(card.getByRole("button", { name: "Pacotes Python" }));
    expect(card.getByRole("button", { name: "Remover pypi.org" })).toBeTruthy();
    await type(card.getByLabelText("Tempo máximo por comando (segundos)"), "5000");
    expect(card.getByText("Use de 5 a 900 segundos.")).toBeTruthy();
    expect(card.getByRole("button", { name: "Salvar" }).hasAttribute("disabled")).toBe(true);
    await type(card.getByLabelText("Tempo máximo por comando (segundos)"), "300");
    await click(card.getByLabelText("Pedir aprovação antes de rodar código"));
    await click(card.getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "sandbox.saveSettings")?.args[1]).toMatchObject({
      allowDomains: ["*.github.com", "pypi.org", "files.pythonhosted.org"],
      execTimeoutSeconds: 300,
      requireApproval: true,
    });
  });

  test("every agent's PC with status, and Ligar / Desligar / Apagar in '…'", async () => {
    const state = await go();
    const list = screen().getByRole("region", { name: "PCs dos agentes" });
    const rows = Array.from(list.querySelectorAll(".computer-row")).map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("Ada");
    expect(rows[0]).toContain("Ligado");
    expect(rows[1]).toContain("Ainda não criado");
    let menu = await openMenu(within(list).getByRole("button", { name: "Ações do PC da Ada" }));
    await click(within(menu).getByRole("menuitem", { name: "Desligar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "sandbox.stop")?.args).toEqual([ORG_ID, ADA_ID]);
    menu = await openMenu(within(list).getByRole("button", { name: "Ações do PC da Ada" }));
    await click(within(menu).getByRole("menuitem", { name: "Apagar" }));
    const confirm = screen().getByRole("dialog", { name: "Apagar o PC da Ada?" });
    expect(confirm.textContent).toContain("Apaga todos os arquivos do PC da Ada.");
    await click(within(confirm).getByRole("button", { name: "Apagar" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "sandbox.remove")).toBe(true);
  });

  test("domains: plain and *. wildcards", () => {
    expect(isDomain("pypi.org")).toBe(true);
    expect(isDomain("*.npmjs.org")).toBe(true);
    expect(isDomain("http://pypi.org")).toBe(false);
    expect(isDomain("*.")).toBe(false);
  });
});

describe("agent profile: PC da Ada", () => {
  test("status, disk, cost and last use", async () => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const pc = screen().getByRole("region", { name: "PC da Ada" });
    expect(pc.textContent).toContain("Ligado");
    expect(pc.textContent).toContain("1,2 GB em disco");
    expect(within(pc).getByRole("button", { name: "Ações do PC da Ada" })).toBeTruthy();
  });
});

describe("Rodar código is not covered by 'Todas as ferramentas'", () => {
  test("all tools on: the sandbox tools stay off until granted on their own", () => {
    const access: AgentAccess = {
      all: true,
      builtins: [
        {
          scope: "issues:write",
          label: "Issues",
          state: "inherited",
          tools: [
            {
              name: "create_issue",
              label: "Criar e editar issues",
              description: "",
              connectionId: null,
              scope: "issues:write",
              sensitive: false,
              readOnly: false,
              state: "inherited",
            },
          ],
        },
        {
          scope: "sandbox:run",
          label: "Rodar código",
          state: "off",
          tools: [
            {
              name: "run_code",
              label: "Rodar código",
              description: "",
              connectionId: null,
              scope: "sandbox:run",
              sensitive: false,
              readOnly: false,
              state: "off",
            },
          ],
        },
      ],
      connectors: [],
    };
    const tree = treeFromAccess(access);
    const r = resolve(tree, modelFrom(access));
    expect(r.find((g) => g.id === "area:sandbox")?.label).toBe("Rodar código");
    expect(r.find((g) => g.id === "area:sandbox")?.children[0]?.state).toBe("off");
    expect(r.find((g) => g.id === "area:issues")?.children[0]?.state).toBe("inherited");
    expect(countTools(r)).toEqual({ on: 1, total: 2 });
  });
});

describe("activity bar: the PC", () => {
  test("verbs for the sandbox tools", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n);
    const say = (tool: string, detail?: string) =>
      activityText(t, [{ id: "a", type: "agent", name: "Theo", activity: toolActivity(tool, null, detail) }]);
    expect(say("run_code")).toBe("Theo está rodando código…");
    expect(say("write_file")).toBe("Theo está mexendo nos arquivos do PC…");
    expect(say("export_file")).toBe("Theo está salvando um arquivo no Drive…");
    expect(say("import_file")).toBe("Theo está trazendo um arquivo do Drive…");
    expect(say("run_skill_script", "Revisão de PR")).toBe("Theo está rodando um script da skill Revisão de PR…");
    expect(say("run_skill_script")).toBe("Theo está rodando um script de skill…");
    expect(say("share_artifact")).toBe("Theo está trazendo um arquivo…");
    expect(t("settings.kinds.sandbox")).toBe("Sandbox");
  });
});
