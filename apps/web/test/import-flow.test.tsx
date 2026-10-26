import { afterEach, describe, expect, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ApiClient, ImportInput, ImportItemResult, ImportPlan } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { fileSaver } from "@/components/artifacts/fileSaver";
import { EXPORT_PROMPT } from "@/lib/import";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const realSave = fileSaver.save;
afterEach(() => {
  cleanup();
  fileSaver.save = realSave;
});

const FIXTURES = join(import.meta.dir, "fixtures", "agent-import");
type State = ReturnType<typeof seedState>;

const go = async (state: State = seedState(), api: ApiClient = createFakeApi(state)) => {
  const r = await renderApp(`/org/${ORG_ID}/settings/import`, { api });
  await settle(6);
  return { ...r, state, api };
};
const button = (name: string | RegExp) => screen().getByRole("button", { name });
const click = async (el: Element, rounds = 4) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: State, method: string) => state.calls.filter((c) => c.method === method);
const applies = (state: State) => calls(state, "imports.apply").map((c) => c.args[1] as ImportInput);
const text = () => document.body.textContent ?? "";

/** Files into one of the flow's pickers ("Arquivos para importar", "Pasta para importar"). */
const pick = async (label: string, files: File[]) => {
  const input = screen().getByLabelText(label) as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  await act(async () => fireEvent.change(input));
  await settle(10);
};
/** A fixture folder as the folder picker gives it: every path under the folder's name. */
const folder = (name: string): File[] => {
  const root = join(FIXTURES, name);
  const walk = (dir: string): string[] =>
    readdirSync(dir)
      .sort()
      .flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  return walk(root).map((path) => {
    const file = new File([readFileSync(path)], basename(path));
    Object.defineProperty(file, "webkitRelativePath", { value: `${name}/${relative(root, path)}` });
    return file;
  });
};
const fixture = (name: string) => new File([readFileSync(join(FIXTURES, name))], name);
/** A fixture folder as a drag-and-drop hands it over: a directory entry walked with its reader. */
const folderEntry = (dir: string, path: string): unknown => {
  const abs = join(FIXTURES, dir);
  if (!statSync(abs).isDirectory()) {
    return { isFile: true, isDirectory: false, fullPath: path, file: (ok: (f: File) => void) => ok(fixture(dir)) };
  }
  const children = readdirSync(abs)
    .sort()
    .map((n) => folderEntry(join(dir, n), `${path}/${n}`));
  return {
    isFile: false,
    isDirectory: true,
    fullPath: path,
    createReader: () => {
      let read = false;
      return {
        readEntries: (ok: (entries: unknown[]) => void) => {
          ok(read ? [] : children);
          read = true;
        },
      };
    },
  };
};
/** Drags `dt` over the flow and drops it. */
const drop = async (dt: { files: File[]; items: unknown[] }) => {
  const zone = document.querySelector(".imp-pick") as HTMLElement;
  const dataTransfer = { ...dt, types: ["Files"], dropEffect: "none" };
  await act(async () => fireEvent.dragOver(zone, { dataTransfer }));
  expect(text()).toContain("Pode soltar");
  await act(async () => fireEvent.drop(zone, { dataTransfer }));
  await settle(10);
};
/** The plan row whose title is `title`. */
const row = (title: string) => {
  const found = [...document.querySelectorAll(".imp-row")].find(
    (r) => r.querySelector(".imp-row__title")?.textContent === title,
  );
  if (!found) throw new Error(`no row ${title}`);
  return found as HTMLElement;
};
const chipOf = (title: string) => row(title).querySelector(".imp-row__chip")?.textContent;
/** A line led by an icon that `.ac-iconline` puts on the line's first row. */
const iconLine = (line: Element | null) =>
  !!line?.classList.contains("ac-iconline") && !!line.firstElementChild?.matches("svg.ac-icon");
/** `imports.apply` answering with `plan` for the dry run (and the default fake otherwise). */
const withPlan = (api: ApiClient, state: State, plan: (input: ImportInput) => ImportItemResult[]) => {
  const fake = api.imports.apply;
  api.imports = {
    ...api.imports,
    apply: async (orgId, input) => {
      if (!input.dryRun) return fake(orgId, input);
      state.calls.push({ method: "imports.apply", args: [orgId, input] });
      return { items: plan(input) };
    },
  };
};

describe("Configurações → Importar e exportar", () => {
  test("admins find it in the nav; the export downloads the bundle, says in one line what never goes, and links the rest", async () => {
    const saved: [string, string][] = [];
    fileSaver.save = (url, name) => saved.push([url, name]);
    await go();
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(nav).getByRole("link", { name: "Importar e exportar" }).getAttribute("aria-current")).toBe("page");
    expect(screen().getByRole("heading", { level: 2, name: "Importar e exportar" })).toBeTruthy();

    // The import card's title alone: the page's subtitle says what importing is for.
    const imports = screen().getByRole("region", { name: "Importar" });
    expect(imports.querySelector(".ac-card__sub")).toBeNull();

    const card = screen().getByRole("region", { name: "Exportar este workspace" });
    expect(card.querySelector(".ac-card__sub, ul, .ac-card__foot")).toBeNull();
    // Whoever shares the file needs to know what never goes in it: one line. The full list is on the help page.
    expect(card.querySelector(".imp-note")?.textContent).toBe("Nunca leva chaves, senhas, logins nem conversas.");
    const whatsIn = within(card).getByRole("link", { name: "O que vai no arquivo" });
    expect(whatsIn.getAttribute("href")).toBe("https://agentes.chat/help/import?lang=pt-BR#export");
    expect(whatsIn.className).toBe("ac-link ac-link--muted");
    expect([whatsIn.getAttribute("target"), whatsIn.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    await click(within(card).getByRole("button", { name: "Baixar o arquivo" }));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.[0]).toBe(`/api/app/organizations/${ORG_ID}/export`);
    expect(saved[0]?.[1]).toMatch(/^agentes-chat-\d{4}-\d{2}-\d{2}\.json$/);
  });

  test("members don't see it", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(nav).queryByRole("link", { name: "Importar e exportar" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Exportar este workspace" })).toBeNull();
  });

  test("each app by its official logo, in the maker's own dark file when the app (not the system) is dark", async () => {
    const device = domWindow().happyDOM.settings.device;
    const logos = () =>
      Object.fromEntries(
        [...document.querySelectorAll(".imp-source")].map((card) => [
          card.querySelector(".ac-option__title")?.textContent,
          card.querySelector(".imp-mark img")?.getAttribute("src") ?? null,
        ]),
      );
    try {
      // The system is dark, but the app is set to light: the light files.
      device.prefersColorScheme = "dark";
      localStorage.setItem("agentes.theme", "light");
      await go();
      expect(logos()["Hermes Agent"]).toBe("/brands/hermes.svg");
      expect(logos().Paperclip).toBe("/brands/paperclip.svg");
      cleanup();
      // The app set to dark: Hermes and Paperclip by their dark files, the others read on both.
      localStorage.setItem("agentes.theme", "dark");
      await go();
      expect(logos()).toEqual({
        OpenClaw: "/brands/openclaw.svg",
        "Hermes Agent": "/brands/hermes-dark.svg",
        "OpenBot.Run": "/brands/openbotrun.svg",
        Paperclip: "/brands/paperclip-dark.svg",
        OpenMausBot: "/brands/openmausbot.svg",
        OpenBot: "/brands/openbot.png",
        "Exportação do agentes.chat": "/favicon.svg",
        // It names many apps: no one maker's logo fits.
        "Outro app": null,
      });
    } finally {
      device.prefersColorScheme = "light";
      localStorage.removeItem("agentes.theme");
    }
  });

  test("the picker: each app by its mark and name alone; the lock line keeps what matters, the rest in its ⓘ", async () => {
    await go();
    expect(document.querySelector(".imp-source .ac-option__desc")).toBeNull();
    expect(button("OpenClaw").textContent).toBe("OpenClaw");
    expect(document.querySelector(".imp-drop__area")?.textContent).toBe(
      "Solte aqui a pasta, o arquivo ou o .zipou clique para escolher",
    );
    // Read before anything is dropped, by whoever is about to drop a folder that holds keys.
    const lock = document.querySelector(".imp-pick > .imp-note") as HTMLElement;
    expect(iconLine(lock)).toBe(true);
    expect(lock.querySelector(".ac-hintline > span")?.textContent).toBe(
      "Lido no seu navegador. Arquivos de chaves e de login nunca são abertos.",
    );
    const about = within(lock).getByRole("button", { name: /^Sobre Lido no seu navegador\./ });
    const more = "Um link do GitHub passa pelo servidor do workspace. Nada muda aqui até você confirmar.";
    expect(document.getElementById(about.getAttribute("aria-describedby") ?? "")?.textContent).toBe(more);
    await click(about, 2);
    expect(screen().getByRole("tooltip").textContent).toBe(more);
  });

  test("its notes and lists lead each line with an icon on the line's first row", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // The import leaves the routine out, so the report lists what didn't come.
    const fake = api.imports.apply;
    api.imports = {
      ...api.imports,
      apply: async (orgId, input) => {
        const { items } = await fake(orgId, input);
        if (input.dryRun) return { items };
        const left = (i: ImportItemResult): ImportItemResult => ({
          ...i,
          action: "skip",
          reason: "schedule_unsupported",
        });
        return { items: items.map((i) => (i.kind === "routine" ? left(i) : i)) };
      },
    };
    await go(state, api);
    const seen: [string, Element[]][] = [];
    const take = (...selectors: string[]) => {
      for (const s of selectors) seen.push([s, [...document.querySelectorAll(s)]]);
    };
    take(".imp-note");
    await click(button(/^OpenClaw$/), 1);
    take(".imp-tip");
    await pick("Pasta para importar", folder("paperclip-company"));
    take(".imp-note", ".imp-todo li");
    await click(button(/^Importar \d+ itens/), 8);
    take(".imp-missed li");
    for (const [selector, lines] of seen) {
      expect([selector, lines.length > 0]).toEqual([selector, true]);
      for (const line of lines) expect([selector, iconLine(line)]).toEqual([selector, true]);
    }
  });

  test("a folder is recognized and planned on the server; unchecking an agent holds back what needs it; Importar applies and reports", async () => {
    const { state } = await go();
    // Every source has a card with where its file is; the drop zone reads any of them.
    for (const name of ["OpenClaw", "Hermes Agent", "OpenBot.Run", "Paperclip", "OpenMausBot", "OpenBot"]) {
      expect(button(new RegExp(`^${name.replace(".", "\\.")}$`))).toBeTruthy();
    }
    await click(button(/^Exportação do agentes\.chat/), 1);
    expect(text()).toContain("Configurações → Importar e exportar → Baixar o arquivo");

    await pick("Pasta para importar", folder("paperclip-company"));
    // Read here, planned there: nothing is written before Importar.
    expect(applies(state).map((i) => i.dryRun)).toEqual([true]);
    const title = screen().getByRole("heading", { name: "Corner Studio" });
    expect(document.activeElement).toBe(title);
    expect(text()).toContain("Veio do Paperclip");
    for (const group of ["Agentes", "Skills", "Rotinas", "Memória"]) {
      expect(screen().getByRole("region", { name: group })).toBeTruthy();
    }
    expect(chipOf("Linus · Chief Technology Officer")).toBe("novo");
    const routines = screen().getByRole("region", { name: "Rotinas" });
    expect(routines.textContent).toContain("Chegam pausadas");
    // Skills land off: "Ligar" is the person's choice, for the agents that had them.
    expect(screen().getByRole("switch", { name: "Ligar para Ada e Linus" }).getAttribute("aria-checked")).toBe("false");

    const bring = (name: string) => screen().getByRole("checkbox", { name: `Trazer ${name}` });
    await click(bring("Ada"), 2);
    expect(bring("Ada").getAttribute("aria-checked")).toBe("false");
    // Her routines can't come without her, and say so.
    expect(within(routines).queryAllByRole("checkbox")).toHaveLength(0);
    expect(chipOf("Heartbeat")).toBe("pulado");
    expect(row("Heartbeat").textContent).toContain("O agente dela não vem.");

    // After importing, and what doesn't come along.
    const todo = screen().getByRole("region", { name: "Depois de importar" });
    expect(todo.textContent).toContain("GH_TOKEN: não vem no arquivo. Se um agente precisar, ele pede no chat.");
    expect(todo.textContent).toContain("Para Ada e Linus");
    const left = screen().getByRole("region", { name: "O que não vem junto" });
    for (const what of ["gpt-imaginary-2", "Landing page", "Engineering"]) expect(left.textContent).toContain(what);

    await click(screen().getByRole("switch", { name: "Ligar para Linus" }), 2);
    await click(button("Importar 3 itens"), 8);
    const applied = applies(state).filter((i) => !i.dryRun);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.pick).toEqual(["skill:review", "agent:cto", "note:COMPANY.md"]);
    expect(applied[0]?.enableSkills).toEqual(["skill:review"]);
    expect(applied[0]?.bundle.agents.map((a) => a.key)).toEqual(["cto"]);

    // The report: what came, with links, and focus on it.
    expect(document.activeElement).toBe(screen().getByRole("heading", { name: "Chegou tudo" }));
    const report = screen().getByRole("region", { name: "Chegou tudo" });
    expect(report.textContent).toContain("1 agente");
    expect(report.textContent).toContain("1 memória");
    const linus = within(report)
      .getAllByRole("link")
      .find((l) => l.textContent?.includes("Linus"));
    expect(linus?.getAttribute("href")).toStartWith(`/org/${ORG_ID}/agents/`);
    expect(within(report).getByRole("link", { name: "Abrir Skills" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/skills`,
    );
    await click(button("Importar outro arquivo"), 2);
    expect(document.activeElement?.textContent).toContain("Solte aqui a pasta, o arquivo ou o .zip");
  });

  test("dropping a file, or a whole folder (walked through its entries), reads it the same way", async () => {
    await go();
    await drop({ files: [fixture("sales-desk.openmaus.json")], items: [] });
    expect(screen().getByRole("heading", { name: "Sales desk" })).toBeTruthy();
    expect(text()).toContain("Veio do OpenMausBot");

    await click(button("Trocar arquivo"), 2);
    await drop({
      files: [],
      items: [{ webkitGetAsEntry: () => folderEntry("openclaw-workspace", "/openclaw-workspace") }],
    });
    expect(screen().getByRole("heading", { name: "Pinch" })).toBeTruthy();
    expect(text()).toContain("Veio do OpenClaw");
    expect(screen().getByRole("checkbox", { name: "Trazer Pinch" }).getAttribute("aria-checked")).toBe("true");
  });

  test("each row says what happens: already here, will update, joins a channel, renamed, skipped and why, cut to fit", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    withPlan(api, state, () => [
      { kind: "skill", key: "pricing-policy", label: "pricing-policy", action: "unchanged" },
      { kind: "skill", key: "research-brief", label: "research-brief", action: "skip", reason: "exists" },
      { kind: "skill", key: "objection-handling", label: "objection-handling", action: "create" },
      { kind: "agent", key: "lead", label: "Morgan", action: "create", renamedTo: "lead2" },
      { kind: "agent", key: "scout", label: "Scout", action: "update" },
      { kind: "agent", key: "writer", label: "Quill", action: "create", reason: "model_not_in_catalog" },
      { kind: "channel", key: "desk", label: "deal-desk", action: "update", reason: "exists" },
      { kind: "channel", key: "room", label: "vendas", action: "update" },
      { kind: "routine", key: "daily-digest", label: "Daily digest", action: "skip", reason: "schedule_unsupported" },
      { kind: "routine", key: "weekly-review", label: "Weekly pipeline review", action: "create" },
      {
        kind: "note",
        key: "lead/MEMORY.md",
        label: "- The team prefers short summaries.",
        action: "skip",
        reason: "secret_like",
      },
      { kind: "note", key: "lead/memory/pricing.md", label: "# Pricing", action: "create", trimmed: ["content"] },
    ]);
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);

    expect(chipOf("pricing-policy")).toBe("já está aqui");
    expect(chipOf("research-brief")).toBe("pulado");
    expect(row("research-brief").textContent).toContain("Já existe uma skill com esse nome aqui. Ela fica como está.");
    expect(chipOf("Morgan · Sales lead")).toBe("novo");
    expect(row("Morgan · Sales lead").textContent).toContain("Vira @lead2: o @lead já existe aqui.");
    expect(chipOf("Scout · Prospect researcher")).toBe("vai atualizar");
    expect(row("Scout · Prospect researcher").textContent).toContain("Mudou no outro app desde a última importação");
    expect(row("Quill · Outreach writer").textContent).toContain("usa o padrão do workspace");
    expect(chipOf("#deal-desk")).toBe("já existe");
    expect(row("#deal-desk").textContent).toContain("Os agentes entram no #deal-desk que já existe.");
    // One an earlier import made: the agents come in, nothing of it "gives way".
    expect(chipOf("#vendas")).toBe("vai atualizar");
    expect(row("#vendas").textContent).toContain("Os agentes entram no #vendas que já existe.");
    expect(row("#vendas").textContent).not.toContain("Mudou no outro app");
    expect(chipOf("Daily digest")).toBe("pulado");
    expect(row("Daily digest").textContent).toContain("Esse horário não dá para agendar aqui.");
    expect(row("The team prefers short summaries.").textContent).toContain("parecido com uma chave ou senha");
    expect(row("Pricing").textContent).toContain("Cortado para caber: texto.");
    // What is already here or skipped isn't a choice; the rest is, checked.
    expect(screen().queryByRole("checkbox", { name: "Trazer pricing-policy" })).toBeNull();
    expect(screen().queryByRole("checkbox", { name: "Trazer Daily digest" })).toBeNull();
    expect(screen().getByRole("checkbox", { name: "Trazer Scout" }).getAttribute("aria-checked")).toBe("true");
    // Skipped rows go last in their group.
    const skills = screen().getByRole("region", { name: "Skills" });
    expect([...skills.querySelectorAll(".imp-row__title")].map((t) => t.textContent)).toEqual([
      "objection-handling",
      "pricing-policy",
      "research-brief",
    ]);
    expect(button("Importar 8 itens")).toBeTruthy();
  });

  test("nothing new, or nothing that can come: it says so instead of offering Importar", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let action: ImportItemResult["action"] = "unchanged";
    withPlan(api, state, (input) =>
      input.bundle.agents.map((a) => ({
        kind: "agent",
        key: a.key,
        label: a.name,
        action,
        ...(action === "skip" ? { reason: "secret_like" as const } : {}),
      })),
    );
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(text()).toContain("Tudo isso já está aqui.");
    expect(iconLine(document.querySelector(".imp-apply__none"))).toBe(true);
    expect(screen().queryByRole("button", { name: /^Importar \d/ })).toBeNull();

    action = "skip";
    await click(button("Trocar arquivo"), 2);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(text()).toContain("Nada daqui pode vir. O motivo está em cada item.");
    expect(screen().queryByRole("button", { name: /^Importar \d/ })).toBeNull();
  });

  test("Outro app: the export request to copy, a link to where each app answers, and a pasted reply read at once", async () => {
    const writes: string[] = [];
    let copyWorks = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (s: string) => {
          if (!copyWorks) throw new Error("denied");
          writes.push(s);
        },
      },
    });
    await go();
    await click(button(/^Outro app/), 2);
    const other = screen().getByRole("region", { name: "Peça para o outro app exportar" });
    expect((within(other).getByLabelText("Pedido de exportação") as HTMLTextAreaElement).value).toBe(EXPORT_PROMPT);
    // Where each app puts its file is on the help page, one link under the request.
    expect(other.querySelector("dl")).toBeNull();
    const where = within(other).getByRole("link", { name: "Onde cada app entrega" });
    expect(where.getAttribute("href")).toBe("https://agentes.chat/help/import?lang=pt-BR#other-apps");
    expect(where.className).toBe("ac-link ac-link--muted");

    await click(within(other).getByRole("button", { name: "Copiar o pedido" }), 2);
    expect(within(other).getByRole("status").textContent).toContain("Não deu para copiar.");
    copyWorks = true;
    await click(within(other).getByRole("button", { name: "Copiar o pedido" }), 2);
    expect(writes).toEqual([EXPORT_PROMPT]);
    expect(within(other).getByRole("button", { name: "Copiado" })).toBeTruthy();
    expect(within(other).getByRole("status").textContent).toBe("Agora é só colar no outro app.");

    const reply = {
      format: "agenteschat.bundle",
      version: 1,
      source: { app: "grok-bot", ref: "my-bots", name: "Minhas automações", files: [] },
      agents: [
        {
          key: "news",
          name: "Newsy",
          handle: "news",
          role: "Notícias do dia",
          instructions: "Resume as notícias do dia em cinco tópicos.",
          model: null,
          appearance: {},
          skills: [],
        },
      ],
      skills: [],
      channels: [],
      routines: [],
      notes: [],
      todo: [],
      leftOut: [],
    };
    const field = screen().getByLabelText("Ou cole um link do GitHub ou a resposta do outro app");
    const pasted = `Aqui está:\n\`\`\`json\n${JSON.stringify(reply, null, 2)}\n\`\`\``;
    await act(async () => fireEvent.paste(field, { clipboardData: { getData: () => pasted } }));
    await settle(10);
    expect(screen().getByRole("heading", { name: "Minhas automações" })).toBeTruthy();
    expect(text()).toContain("Veio do Grok Bot");
    expect(screen().getByRole("checkbox", { name: "Trazer Newsy" }).getAttribute("aria-checked")).toBe("true");
  });

  test("what went wrong says what to do next, with Tentar de novo only where trying again helps", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const fake = api.imports.apply;
    let fail: ApiError | null = null;
    api.imports = {
      ...api.imports,
      apply: async (orgId, input) => {
        const error = fail;
        fail = null;
        if (error) throw error;
        return fake(orgId, input);
      },
    };
    await go(state, api);
    const alert = () => screen().getByRole("alert").textContent ?? "";
    const retry = () => screen().queryByRole("button", { name: "Tentar de novo" });

    await pick("Arquivos para importar", [new File(["Lista de compras: café, pão."], "notas.txt")]);
    expect(alert()).toContain("Não reconhecemos esses arquivos");
    expect(retry()).toBeNull();

    const field = screen().getByLabelText("Ou cole um link do GitHub ou a resposta do outro app");
    await act(async () => fireEvent.change(field, { target: { value: "https://gitlab.com/acme/agents" } }));
    await click(button("Ler"), 6);
    expect(alert()).toContain("só lê links do GitHub");
    expect(calls(state, "agents.importFromGithub")).toHaveLength(0);

    await act(async () => fireEvent.paste(field, { clipboardData: { getData: () => "oi, tudo bem?" } }));
    await settle(6);
    expect(alert()).toContain("Não reconhecemos esse texto. Cole a resposta inteira do outro app");

    fail = new ApiError(500, "internal", "boom");
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(alert()).toContain("Lemos os arquivos, mas não deu para comparar com o workspace.");
    await click(retry() as HTMLElement, 10);
    expect(screen().getByRole("heading", { name: "Sales desk" })).toBeTruthy();

    await click(button("Trocar arquivo"), 2);
    fail = new ApiError(413, "import.too_large", "The import is too large (max 32 MB)");
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(alert()).toContain("É coisa demais para uma importação só (até 32 MB).");
    expect(retry()).toBeNull();
  });

  test("Cancelar stops waiting for a slow plan, and its answer is dropped", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let answer: (plan: ImportPlan) => void = () => {};
    api.imports = { ...api.imports, apply: () => new Promise<ImportPlan>((resolve) => (answer = resolve)) };
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(screen().getByRole("status").textContent).toContain("Comparando com o que já está aqui…");
    await click(button("Cancelar"), 2);
    expect(document.activeElement?.textContent).toContain("Solte aqui a pasta, o arquivo ou o .zip");
    await act(async () => answer({ items: [{ kind: "agent", key: "lead", label: "Morgan", action: "create" }] }));
    await settle(4);
    expect(screen().queryByRole("heading", { name: "Sales desk" })).toBeNull();
  });

  test("a file dropped while another is being read is caught (never opened by the browser) and not read", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let asked = 0;
    api.imports = {
      ...api.imports,
      apply: () => {
        asked++;
        return new Promise<ImportPlan>(() => {});
      },
    };
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    expect(screen().getByRole("status").textContent).toContain("Comparando com o que já está aqui…");
    const zone = document.querySelector(".imp-pick") as HTMLElement;
    const dataTransfer = {
      files: [fixture("sales-desk.openmaus.json")],
      items: [],
      types: ["Files"],
      dropEffect: "copy",
    };
    let over = true;
    let dropped = true;
    await act(async () => {
      over = fireEvent.dragOver(zone, { dataTransfer });
    });
    expect(text()).not.toContain("Pode soltar");
    await act(async () => {
      dropped = fireEvent.drop(zone, { dataTransfer });
    });
    await settle(6);
    // Default prevented: the browser doesn't navigate to the file.
    expect([over, dropped]).toEqual([false, false]);
    expect(asked).toBe(1);
    expect(screen().getByRole("status").textContent).toContain("Comparando com o que já está aqui…");
  });

  test("a skill's Ligar names only the agents this import brings: one already here turns it on in its own page", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    withPlan(api, state, () => [
      { kind: "skill", key: "review", label: "review", action: "create" },
      { kind: "agent", key: "cto", label: "Linus", action: "create" },
      { kind: "agent", key: "ceo", label: "Ada", action: "unchanged" },
    ]);
    await go(state, api);
    await pick("Pasta para importar", folder("paperclip-company"));
    expect(screen().getByRole("switch", { name: "Ligar para Linus" })).toBeTruthy();
    expect(screen().queryByRole("switch", { name: /Ada/ })).toBeNull();
    // Linus unchecked: nobody coming uses it.
    await click(screen().getByRole("checkbox", { name: "Trazer Linus" }), 2);
    expect(screen().queryByRole("switch", { name: /^Ligar para/ })).toBeNull();
    expect(row("review").textContent).toContain("Nenhum agente que vem usa esta skill.");
  });

  test("an apply that fails keeps what came, says so, and Importar again brings the rest", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const fake = api.imports.apply;
    let failures = 1;
    api.imports = {
      ...api.imports,
      apply: async (orgId, input) => {
        if (!input.dryRun && failures-- > 0) throw new TypeError("Failed to fetch");
        return fake(orgId, input);
      },
    };
    await go(state, api);
    await pick("Arquivos para importar", [fixture("sales-desk.openmaus.json")]);
    await click(button("Importar 11 itens"), 8);
    expect(screen().getByRole("alert").textContent).toContain("Sem internet");
    await click(button("Importar 11 itens"), 8);
    expect(screen().getByRole("heading", { name: "Chegou tudo" })).toBeTruthy();
    expect(text()).toContain("3 agentes");
    expect(text()).toContain("Chegaram pausadas: ligue em Rotinas quando quiser.");
  });
});
