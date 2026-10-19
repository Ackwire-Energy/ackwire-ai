import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentAccess } from "@agenteschat/client";
import { inputWithLevels, levelsOf, resourcesOf } from "@agenteschat/client/lib/access-levels";
import { activityText, toolActivity } from "@agenteschat/client/lib/activity";
import { busyView, ELAPSED_AFTER_MS, GIVE_UP_MS, PREPARE_AFTER_MS, reached } from "@agenteschat/client/lib/computer";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { isDomain } from "@/components/AgentComputer";
import { createI18n } from "@/i18n";
import { ADA_ID, ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
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

describe("Configurações → Computadores: the cloud computer", () => {
  const go = async (state = seedState()) => {
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api: createFakeApi(state) });
    await settle(8);
    return state;
  };

  test("the card: on/off and a summary; internet, limits and approval in the Ajustar dialog", async () => {
    const state = await go();
    const region = screen().getByRole("region", { name: "Computador na nuvem" });
    expect(region.textContent).toContain("Sem internet · até");
    // Only the switch and Ajustar on the card.
    expect(within(region).queryByRole("radio")).toBeNull();
    await click(within(region).getByRole("button", { name: "Ajustar" }));
    const dialog = screen().getByRole("dialog", { name: "Computador na nuvem" });
    const card = within(dialog);
    expect(card.getByRole("radio", { name: /Sem internet/ }).getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toContain("O que o computador na nuvem acessa lá fora.");
    // Only for the cloud computer: the person's own computers follow the app.
    expect(card.getByRole("note").textContent).toContain("quem decide o que os agentes podem fazer é o app agentes");
    // The domain list only for "Só os sites liberados".
    expect(card.queryByLabelText("Adicionar site")).toBeNull();
    await click(card.getByRole("radio", { name: /Só os sites liberados/ }));
    expect(card.getByText("Libere pelo menos um site, ou escolha sem internet ou qualquer site.")).toBeTruthy();
    await type(card.getByLabelText("Adicionar site"), "não é domínio");
    await click(card.getByRole("button", { name: "Adicionar" }));
    expect(card.getByText("Use um domínio como api.exemplo.com ou *.exemplo.com.")).toBeTruthy();
    await type(card.getByLabelText("Adicionar site"), "*.github.com");
    await click(card.getByRole("button", { name: "Adicionar" }));
    await click(card.getByRole("button", { name: "Pacotes Python" }));
    expect(card.getByRole("button", { name: "Remover pypi.org" })).toBeTruthy();
    await type(card.getByLabelText("Tempo máximo de cada comando (segundos)"), "5000");
    expect(card.getByText("Use de 5 a 900 segundos.")).toBeTruthy();
    expect(card.getByRole("button", { name: "Salvar" }).hasAttribute("disabled")).toBe(true);
    await type(card.getByLabelText("Tempo máximo de cada comando (segundos)"), "300");
    await click(card.getByLabelText("Pedir aprovação antes de rodar código"));
    await click(card.getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "sandbox.saveSettings")?.args[1]).toMatchObject({
      network: "allowlist",
      allowDomains: ["*.github.com", "pypi.org", "files.pythonhosted.org"],
      execTimeoutSeconds: 300,
      requireApproval: true,
    });
    // Saved: the dialog closes.
    expect(screen().queryByRole("dialog", { name: "Computador na nuvem" })).toBeNull();
  });

  test("every agent's cloud computer with status, and Ligar / Desligar / Apagar in '…'", async () => {
    const state = await go();
    const list = screen().getByRole("region", { name: "Qual computador cada agente usa" });
    const rows = Array.from(list.querySelectorAll(".computers-agent")).map((r) => r.textContent ?? "");
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

describe("internet mode", () => {
  test("Qualquer site warns; saving says the running cloud computers got it", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api: createFakeApi(state) });
    await settle(8);
    await click(
      within(screen().getByRole("region", { name: "Computador na nuvem" })).getByRole("button", { name: "Ajustar" }),
    );
    const card = within(screen().getByRole("dialog", { name: "Computador na nuvem" }));
    await click(card.getByRole("radio", { name: /Qualquer site/ }));
    expect(card.getAllByRole("note").map((n) => n.textContent)).toContain(
      "O agente acessa qualquer site. Chaves e segredos continuam fora da máquina.",
    );
    await click(card.getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "sandbox.saveSettings")?.args[1]).toMatchObject({ network: "open" });
    expect(document.body.textContent).toContain("Os computadores na nuvem ligados já usam a nova regra de internet.");
  });
});

describe("agent profile: PC da Ada", () => {
  test("status, disk, cost and last use", async () => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { api: createFakeApi(seedState()) });
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
    expect(resourcesOf(access).map((r) => [r.id, r.levels.join("/"), r.notInAll])).toEqual([
      ["area:issues", "none/write", false],
      ["area:sandbox", "none/write", true],
    ]);
    expect(levelsOf(access)).toEqual({ "area:issues": "write", "area:sandbox": "none" });
    // Lowering another area spells "all tools" out, and running code stays off.
    const put = inputWithLevels(access, [], { "area:issues": "none" });
    expect(put.all).toBe(false);
    expect(put.scopes).toEqual([]);
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

describe("creating the PC feels alive", () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const running = {
    status: "running" as const,
    diskUsedGib: 0.1,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };

  test("no PC yet: explanation + Criar; click → Ligando… with the step, then Ligado and a toast", async () => {
    const api = createFakeApi(seedState());
    const start = deferred<typeof running>();
    api.sandbox.start = () => start.promise;
    await renderApp(`/org/${ORG_ID}/agents/${ATLAS_ID}?tab=settings`, { api });
    await settle(8);
    const pc = screen().getByRole("region", { name: "PC do Atlas" });
    expect(pc.textContent).toContain("Um computador só do Atlas para rodar código e guardar arquivos.");
    await click(within(pc).getByRole("button", { name: "Criar PC do Atlas" }));
    expect(pc.textContent).toContain("Ligando…");
    expect(pc.textContent).toContain("Criando a máquina");
    expect(within(pc).queryByRole("button", { name: "Criar PC do Atlas" })).toBeNull();
    expect(within(pc).getByRole("button", { name: "Ações do PC do Atlas" }).hasAttribute("disabled")).toBe(true);
    await act(async () => start.resolve(running));
    await settle(4);
    expect(pc.textContent).toContain("Ligado");
    expect(pc.textContent).toContain("Pronto");
    expect(document.body.textContent).toContain("PC do Atlas ligado");
  });

  test("it fails: the reason inline and Tentar de novo", async () => {
    const api = createFakeApi(seedState());
    let calls = 0;
    api.sandbox.start = async () => {
      calls += 1;
      throw new Error("sem cota no provedor");
    };
    await renderApp(`/org/${ORG_ID}/agents/${ATLAS_ID}?tab=settings`, { api });
    await settle(8);
    const pc = screen().getByRole("region", { name: "PC do Atlas" });
    await click(within(pc).getByRole("button", { name: "Criar PC do Atlas" }));
    await settle(4);
    expect(within(pc).getByRole("alert").textContent).toContain("Não deu para ligar: sem cota no provedor");
    await click(within(pc).getByRole("button", { name: "Tentar de novo" }));
    await settle(4);
    expect(calls).toBe(2);
  });

  test("steps and elapsed seconds follow the clock (fake time)", () => {
    const t0 = 1_000_000;
    expect(busyView("start", t0, t0, true)).toEqual({ step: "creating", elapsed: null, tooLong: false });
    expect(busyView("start", t0, t0 + ELAPSED_AFTER_MS - 1, true).elapsed).toBeNull();
    expect(busyView("start", t0, t0 + ELAPSED_AFTER_MS, true).elapsed).toBe(3);
    expect(busyView("start", t0, t0 + PREPARE_AFTER_MS, true).step).toBe("preparing");
    expect(busyView("start", t0, t0 + 1000, false).step).toBe("booting");
    expect(busyView("stop", t0, t0 + 7_400, false)).toEqual({ step: null, elapsed: 7, tooLong: false });
    expect(busyView("start", t0, t0 + GIVE_UP_MS, true).tooLong).toBe(true);
    expect(reached("start", "running")).toBe(true);
    expect(reached("stop", "running")).toBe(false);
    expect(reached("remove", "none")).toBe(true);
  });
});
