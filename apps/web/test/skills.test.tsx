import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { activityText, toolActivity } from "@agenteschat/client/lib/activity";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { proceed, startAs } from "./new-agent-flow";
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
const pickTab = async (tab: HTMLElement) => {
  tab.focus();
  await key(tab, "Enter");
  await act(async () => fireEvent.mouseDown(tab));
};
const settings = async (state = seedState(), api = createFakeApi(state)) => {
  await renderApp(`/org/${ORG_ID}/settings/skills`, { api });
  await settle(8);
  return { state, api, section: () => screen().getByRole("region", { name: "Skills" }) };
};

describe("Configurações → Skills", () => {
  test("the library: name, description, source, version and how many agents use it", async () => {
    const { section } = await settings();
    // The card's head is its title and Install: what a skill is lives in Settings' own line above it.
    expect(section().querySelector("#sec-skills")?.parentElement?.textContent).toBe("SkillsInstalar skill");
    const rows = within(section()).getAllByRole("button", { name: /Revisão de PR|Relatório semanal|Atendimento/ });
    expect(rows.map((r) => r.textContent)).toEqual(["Revisão de PR", "Relatório semanal", "Atendimento"]);
    const review = rows[0]?.closest(".skill-row") as HTMLElement;
    expect(review.textContent).toContain("Use quando pedirem para revisar um pull request.");
    expect(review.textContent).toContain("GitHub");
    expect(review.textContent).toContain("v3");
    expect(review.textContent).toContain("1 agente usa");
    expect((rows[1]?.closest(".skill-row") as HTMLElement | null)?.textContent).toContain("Criada aqui");
    expect((rows[1]?.closest(".skill-row") as HTMLElement | null)?.textContent).toContain("Em agentes novos");
    expect((rows[2]?.closest(".skill-row") as HTMLElement | null)?.textContent).toContain("Enviada");
    // GitHub is named by its own mark, the connector catalog's; the other sources keep their icons.
    const chip = (name: string) =>
      [...section().querySelectorAll(".skill-row .ac-chip")].find((c) => c.textContent === name) as HTMLElement;
    const github = chip("GitHub").querySelector<HTMLElement>(".connector-icon__mark");
    expect(github?.style.getPropertyValue("--connector-icon")).toBe('url("/connectors/github.svg")');
    expect(chip("GitHub").querySelector("svg.ac-icon")).toBeNull();
    for (const name of ["Criada aqui", "Enviada"]) {
      expect(chip(name).querySelector(".connector-icon")).toBeNull();
      expect(chip(name).querySelector("svg.ac-icon")).not.toBeNull();
    }
  });

  test("detail: rendered body, files (scripts need a sandbox), remove names the agents", async () => {
    const { state, section } = await settings();
    await click(within(section()).getByRole("button", { name: "Revisão de PR" }));
    await settle(4);
    const sheet = screen().getByRole("dialog", { name: "Revisão de PR" });
    // The sheet title and the body's own heading.
    expect(within(sheet).getAllByRole("heading", { name: "Revisão de PR" }).length).toBeGreaterThanOrEqual(2);
    expect(sheet.querySelector("pre.code-card__code code")?.textContent).toBe("bun test");
    const files = within(sheet).getByRole("navigation", { name: "Arquivos" });
    // Scripts run on the agent's PC; old imports kept them as ignored.
    const script = within(files).getByText("scripts/lint.sh").closest(".skill-file") as HTMLElement;
    expect(script.textContent).toContain("roda no PC do agente");
    const old = within(files).getByText("scripts/old.py").closest(".skill-file") as HTMLElement;
    expect(old.textContent).toContain("precisa de sandbox");
    expect(old.textContent).toContain("Reinstale para usar os scripts.");
    const text = within(files).getByText("checklist.md").closest(".skill-file") as HTMLElement;
    expect(text.textContent).toContain("text/markdown");
    expect(text.textContent).not.toContain("precisa de sandbox");
    await click(within(sheet).getByRole("button", { name: "Remover" }));
    const confirm = screen().getByRole("dialog", { name: "Remover Revisão de PR?" });
    expect(confirm.textContent).toContain("Ada usa esta skill e deixa de ter acesso a ela.");
    await click(within(confirm).getByRole("button", { name: "Remover" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "skills.remove")).toBe(true);
    expect(screen().getByText("Revisão de PR removida.")).toBeTruthy();
  });

  test("Instalar skill: GitHub link, .zip and Escrever", async () => {
    const { state, section } = await settings();
    await click(within(section()).getByRole("button", { name: "Instalar skill" }));
    let dialog = screen().getByRole("dialog", { name: "Instalar skill" });
    await type(within(dialog).getByRole("textbox", { name: "Link do GitHub" }), "nao-e-link");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    expect(dialog.textContent).toContain("Use um link do GitHub");
    await type(
      within(dialog).getByRole("textbox", { name: "Link do GitHub" }),
      "https://github.com/acme/skills/tree/main/deploy",
    );
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "skills.import")?.args[1]).toEqual({
      url: "https://github.com/acme/skills/tree/main/deploy",
    });
    // The new skill opens.
    expect(screen().getByRole("dialog", { name: "deploy" })).toBeTruthy();
    await click(within(screen().getByRole("dialog", { name: "deploy" })).getByRole("button", { name: "Fechar" }));
    await settle(2);

    await click(within(section()).getByRole("button", { name: "Instalar skill" }));
    dialog = screen().getByRole("dialog", { name: "Instalar skill" });
    await pickTab(within(dialog).getByRole("tab", { name: "Enviar .zip" }));
    // What the .zip holds, nothing about its scripts: they can run on the agent's computer, as its sheet says.
    expect(within(dialog).getByText(/^Um \.zip/).textContent).toBe("Um .zip com o SKILL.md na raiz.");
    expect(dialog.querySelector('input[type="file"]')?.className).toContain("ac-visually-hidden");
    const file = new File([new Uint8Array([80, 75, 3, 4])], "suporte.zip", { type: "application/zip" });
    await act(async () => {
      fireEvent.change(dialog.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    });
    expect(dialog.textContent).toContain("suporte.zip");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    const zip = state.calls.filter((c) => c.method === "skills.import").at(-1)?.args[1] as { zipBase64: string };
    expect(zip.zipBase64).toBe(btoa(String.fromCharCode(80, 75, 3, 4)));
    await click(
      within(screen().getByRole("dialog", { name: "Skill enviada" })).getByRole("button", { name: "Fechar" }),
    );
    await settle(2);

    await click(within(section()).getByRole("button", { name: "Instalar skill" }));
    dialog = screen().getByRole("dialog", { name: "Instalar skill" });
    await pickTab(within(dialog).getByRole("tab", { name: "Escrever" }));
    await type(within(dialog).getByLabelText("Nome"), "Deploy seguro");
    await type(within(dialog).getByLabelText("Quando usar"), "Antes de qualquer deploy.");
    await type(within(dialog).getByLabelText("Instruções (Markdown)"), "# Deploy\n\n1. Confira o CI.");
    await click(within(dialog).getByRole("button", { name: "Instalar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "skills.create")?.args[1]).toMatchObject({ name: "Deploy seguro" });
  });

  test("long libraries: 'Ver todas' opens a search dialog", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.skills.list(ORG_ID);
    for (let i = 1; i <= 5; i++) {
      await api.skills.create(ORG_ID, { name: `Extra ${i}`, description: "x", body: "# x" });
    }
    const { section } = await settings(state, api);
    await click(within(section()).getByRole("button", { name: "Ver todas as 8 skills" }));
    const dialog = screen().getByRole("dialog", { name: "Skills" });
    await type(within(dialog).getByRole("searchbox", { name: "Buscar skill" }), "extra 3");
    expect(
      within(dialog)
        .getAllByRole("button", { name: /Extra/ })
        .map((b) => b.textContent),
    ).toEqual(["Extra 3"]);
  });

  test("members don't see the library", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const { api } = await settings(state);
    expect(screen().queryByRole("region", { name: "Skills" })).toBeNull();
    expect(api).toBeTruthy();
  });
});

describe("agent skills", () => {
  test("Ferramentas e acesso: the library as checkboxes; a change waits for Salvar and sends every skill", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api: createFakeApi(state) });
    await settle(8);
    const section = screen().getByRole("region", { name: "Skills" });
    expect(
      within(section)
        .getByRole("checkbox", { name: /Revisão de PR/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(section)
        .getByRole("checkbox", { name: /Atendimento/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    await click(within(section).getByRole("checkbox", { name: /Atendimento/ }));
    expect(state.calls.find((c) => c.method === "skills.setForAgent")).toBeUndefined();
    expect(section.textContent).toContain("Antes: 1 ligada");
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(6);
    const set = state.calls.find((c) => c.method === "skills.setForAgent")?.args;
    expect(set?.[1]).toBe(ADA_ID);
    const sent = set?.[2] as { skillId: string; enabled: boolean }[];
    expect(sent).toHaveLength(3);
    expect(sent.filter((x) => x.enabled)).toHaveLength(2);
    expect(
      within(screen().getByRole("region", { name: "Skills" }))
        .getByRole("checkbox", { name: /Atendimento/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("Criar agente: optional Skills under the tools, the ones on for new agents already checked", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/agents/new`, { api: createFakeApi(state) });
    await settle(8);
    await startAs("QA");
    await proceed(2);
    const step = screen().getByRole("region", { name: /^Skills/ });
    // "Ligar em agentes novos" skills start checked.
    expect(
      within(step)
        .getByRole("checkbox", { name: /Relatório semanal/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await click(within(step).getByRole("checkbox", { name: /Atendimento/ }));
    expect(screen().getByRole("complementary", { name: "Prévia do agente" }).textContent).toContain("Atendimento");
    await proceed(3);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(8);
    const sent = state.calls.find((c) => c.method === "skills.setForAgent")?.args[2] as {
      skillId: string;
      enabled: boolean;
    }[];
    expect(sent.filter((x) => x.enabled)).toHaveLength(2);
  });
});

describe("activity bar: load_skill", () => {
  test("names the skill when it can; otherwise 'consultando uma skill'", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n);
    expect(toolActivity("load_skill", null, "Revisão de PR")).toEqual({ kind: "openingSkill", app: "Revisão de PR" });
    expect(toolActivity("load_skill")).toEqual({ kind: "consultingSkill" });
    expect(
      activityText(t, [
        { id: "a", type: "agent", name: "Theo", activity: toolActivity("load_skill", null, "Revisão de PR") },
      ]),
    ).toBe("Theo está abrindo a skill Revisão de PR…");
    expect(activityText(t, [{ id: "a", type: "agent", name: "Theo", activity: toolActivity("load_skill") }])).toBe(
      "Theo está consultando uma skill…",
    );
  });
});
