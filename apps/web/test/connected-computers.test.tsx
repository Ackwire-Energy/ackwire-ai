import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentComputer, Machine } from "@agenteschat/client";
import { ApiError, applyComputerEvent, applyMachineEvent, keys } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { fileIcon, formatBytes, MAX_UPLOAD_BYTES, previewKind } from "@agenteschat/client/lib/files";
import { taskNoticeOf } from "@agenteschat/client/lib/missions";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { fileSaver } from "@/components/artifacts/ArtifactViewer";
import { objectUrls } from "@/components/artifacts/FileView";
import { createI18n } from "@/i18n";
import { ADA_ID, createFakeApi, ENG_ID, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

const saved: { url: string; name: string }[] = [];
const realSave = fileSaver.save;
const realCreate = objectUrls.create;
const realRevoke = objectUrls.revoke;
let urls = 0;
beforeAll(() => {
  fileSaver.save = (url, name) => {
    saved.push({ url, name });
  };
  objectUrls.create = () => `blob:preview-${++urls}`;
  objectUrls.revoke = () => {};
});
afterAll(() => {
  fileSaver.save = realSave;
  objectUrls.create = realCreate;
  objectUrls.revoke = realRevoke;
});
afterEach(() => {
  cleanup();
  saved.length = 0;
  Reflect.deleteProperty(navigator, "userAgent");
});

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const ARM_LINUX_UA = "Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
/** The page as a browser on that system opens it (the test DOM's own user agent comes back after each test). */
const asBrowserOn = (ua: string) => Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });

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
/** Picks files in a hidden file input. */
const choose = (input: Element, files: File[]) => act(async () => fireEvent.change(input, { target: { files } }));
const png = (name = "grafico.png") =>
  new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], name, { type: "image/png" });
const orgEvent = (event: Record<string, unknown>) => ({ type: "event", scope: "org", event });

describe("uploaded files in the Drive", () => {
  test("an image: icon, name, size, Baixar, and an inline preview from the download", async () => {
    const api = createFakeApi(seedState());
    const file = await api.artifacts.upload(ORG_ID, png());
    await renderApp(`/org/${ORG_ID}/drive?artifact=${file.id}`, { api });
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "grafico.png" });
    expect(dialog.textContent).toContain("Arquivo");
    expect(dialog.querySelector(".file-summary")?.textContent).toMatch(/grafico\.png7\s?(byte|B)/);
    const img = within(dialog).getByRole("img", { name: "Imagem: grafico.png" });
    expect(img.getAttribute("src")).toMatch(/^blob:preview-/);
    // Text kinds' Editar never shows for files; Baixar saves the original with its name.
    expect(within(dialog).queryByRole("button", { name: "Editar" })).toBeNull();
    const downloads = within(dialog).getAllByRole("button", { name: "Baixar" });
    await click(downloads[0] as HTMLElement);
    expect(saved[0]).toEqual({
      url: `/api/app/organizations/${ORG_ID}/artifacts/${file.id}/file?version=1`,
      name: "grafico.png",
    });
  });

  test("in a chat card: an image shows its thumbnail (opens the viewer); other files show name, size and Baixar", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const image = await api.artifacts.upload(ORG_ID, png("contato.jpg"));
    const zip = await api.artifacts.upload(
      ORG_ID,
      new File([new Uint8Array([80, 75, 3, 4])], "carrossel.zip", { type: "application/zip" }),
    );
    const base = state.messages[0] as (typeof state.messages)[number];
    state.messages.push({
      ...base,
      id: "m-files",
      threadId: null,
      body: "Aqui estão os arquivos.",
      mentionedAgentIds: [],
      meta: {
        artifacts: [
          { id: image.id, version: 1 },
          { id: zip.id, version: 1 },
        ],
      },
      createdAt: new Date().toISOString(),
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    // Both are tiles side by side in the message, not full cards.
    expect(document.querySelectorAll(".artifact-cards > .artifact-tile")).toHaveLength(2);
    const thumb = document.querySelector(".file-thumb") as HTMLElement;
    expect(thumb).not.toBeNull();
    expect(within(thumb).getByRole("img").getAttribute("src")).toMatch(/^blob:preview-/);
    expect(thumb.textContent).toContain("contato.jpg");
    const row = document.querySelector(".file-row") as HTMLElement;
    expect(row.textContent).toContain("carrossel.zip");
    await click(within(row).getByRole("button", { name: "Baixar" }));
    expect(saved.at(-1)).toEqual({
      url: `/api/app/organizations/${ORG_ID}/artifacts/${zip.id}/file?version=1`,
      name: "carrossel.zip",
    });
    await click(thumb);
    await settle(4);
    expect(screen().getByRole("dialog", { name: "contato.jpg" })).toBeTruthy();
  });

  test("SVG and other types are download-only; small text files show their text, read-only", async () => {
    const api = createFakeApi(seedState());
    const svg = await api.artifacts.upload(
      ORG_ID,
      new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], "logo.svg", {
        type: "image/svg+xml",
      }),
    );
    const notes = await api.artifacts.upload(
      ORG_ID,
      new File(["linha 1\nlinha 2"], "notas.txt", { type: "text/plain" }),
    );
    await renderApp(`/org/${ORG_ID}/drive?artifact=${svg.id}`, { api });
    await settle(8);
    let dialog = screen().getByRole("dialog", { name: "logo.svg" });
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.querySelector("iframe")).toBeNull();
    expect(dialog.textContent).toContain("Sem prévia para este tipo de arquivo.");
    cleanup();
    await renderApp(`/org/${ORG_ID}/drive?artifact=${notes.id}`, { api });
    await settle(8);
    dialog = screen().getByRole("dialog", { name: "notas.txt" });
    expect(dialog.querySelector(".file-view__text")?.textContent).toBe("linha 1\nlinha 2");
    expect(dialog.querySelector("textarea")).toBeNull();
  });

  test("an upload keeps the original name, type and size, and is always untrusted", async () => {
    const api = createFakeApi(seedState());
    const file = await api.artifacts.upload(ORG_ID, png("mapa.png"));
    const detail = await api.artifacts.get(ORG_ID, file.id);
    expect(detail.content).toMatchObject({ kind: "file", name: "mapa.png", contentType: "image/png", size: 7 });
    expect(detail.untrusted).toBe(true);
  });

  test("Enviar arquivo: the picker uploads, the list updates and a toast offers Abrir", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    expect(screen().getByRole("button", { name: "Enviar arquivo" })).toBeTruthy();
    const input = document.querySelector("input[data-upload-input]") as HTMLInputElement;
    await choose(input, [png("vendas.png")]);
    await settle(6);
    expect(state.calls.find((c) => c.method === "artifacts.upload")?.args.slice(0, 2)).toEqual([ORG_ID, "vendas.png"]);
    expect(screen().getByText("“vendas.png” está no Drive.")).toBeTruthy();
    expect(screen().getByRole("button", { name: "vendas.png" })).toBeTruthy();
    await click(screen().getByRole("button", { name: "Abrir" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "vendas.png" })).toBeTruthy();
  });

  test("over 50 MB: a translated message and nothing is sent", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    const big = png("video.png");
    Object.defineProperty(big, "size", { value: MAX_UPLOAD_BYTES + 1 });
    await choose(document.querySelector("input[data-upload-input]") as HTMLInputElement, [big]);
    await settle(4);
    expect(screen().getByRole("alert").textContent).toContain("“video.png” passa de 50 MB, o limite por arquivo.");
    expect(state.calls.some((c) => c.method === "artifacts.upload")).toBe(false);
  });

  test("dropping files on the Drive uploads them", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    const page = document.querySelector(".drive-drop") as HTMLElement;
    const dataTransfer = { types: ["Files"], files: [png("solto.png")], dropEffect: "none" };
    await act(async () => fireEvent.dragEnter(page, { dataTransfer }));
    expect(page.classList.contains("drive-drop--over")).toBe(true);
    expect(page.textContent).toContain("Solte para enviar ao Drive");
    await act(async () => fireEvent.drop(page, { dataTransfer }));
    await settle(6);
    expect(page.classList.contains("drive-drop--over")).toBe(false);
    expect(state.calls.find((c) => c.method === "artifacts.upload")?.args[1]).toBe("solto.png");
  });

  test("Enviar nova versão on a file I can edit", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const file = await api.artifacts.upload(ORG_ID, png());
    await renderApp(`/org/${ORG_ID}/drive?artifact=${file.id}`, { api });
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "grafico.png" });
    expect(within(dialog).getByRole("button", { name: "Enviar nova versão" })).toBeTruthy();
    await choose(dialog.querySelector("input[data-upload-input]") as HTMLInputElement, [png("grafico-v2.png")]);
    await settle(6);
    expect(state.calls.find((c) => c.method === "artifacts.uploadVersion")?.args.slice(0, 3)).toEqual([
      ORG_ID,
      file.id,
      "grafico-v2.png",
    ]);
    expect(screen().getByText("Versão 2 salva.")).toBeTruthy();
    const history = within(screen().getByRole("dialog")).getByRole("navigation", { name: "Versões" });
    expect(within(history).getAllByRole("button")).toHaveLength(2);
  });
});

describe("Configurações → Computadores", () => {
  const go = async (state = seedState()) => {
    const api = createFakeApi(state);
    const r = await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    return {
      ...r,
      api,
      state,
      socket,
      machines: fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>,
    };
  };

  test("one section (Sandbox joined it): one lead line, other computers and how to connect one", async () => {
    await go();
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    const links = within(nav)
      .getAllByRole("link")
      .map((l) => l.textContent);
    expect(links).toContain("Computadores");
    expect(links).not.toContain("Sandbox");
    const body = document.querySelector(".settings__body") as HTMLElement;
    expect(body.textContent).toContain(
      "Onde os agentes trabalham: o computador deste servidor e qualquer outro computador que você conectar.",
    );
    // No kinds side by side anymore, and never "in the cloud" here.
    expect(screen().queryByRole("region", { name: "Onde os agentes trabalham" })).toBeNull();
    expect(body.textContent).not.toMatch(/Na nuvem|No seu computador|Computador na nuvem/);
    expect(screen().getByRole("region", { name: "Outros computadores" })).toBeTruthy();
    // The empty state is its title: how to connect one is the card right under it.
    expect(screen().getByText("Nenhum outro computador ainda")).toBeTruthy();
    expect(body.textContent).not.toContain("Conecte um Mac pelo app agentes");
    expect(screen().getByRole("region", { name: "Conectar outro computador" })).toBeTruthy();
    // Never internal names in the UI.
    expect(body.textContent).not.toMatch(/runner|MCP/i);
  });

  test("the old Sandbox address opens Computadores", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/settings/sandbox`, { api: createFakeApi(seedState()) });
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/computers`);
  });

  test("which computer each agent uses: picked here and saved at once; the counts follow", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const m = fakeMachinesOf.get(api)?.pair({ name: "Escritório", os: "darwin" }) as Machine;
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    const card = screen().getByRole("region", { name: "Qual computador cada agente usa" });
    const trigger = within(card).getByRole("combobox", { name: "Computador de Ada" });
    // This server has Daytona's sandboxes: they're the "no computer" choice, by name.
    expect(trigger.textContent).toContain("Sandbox da Daytona");
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    await act(async () => fireEvent.click(screen().getByRole("option", { name: /^Escritório/ })));
    await settle(6);
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args).toEqual([ORG_ID, ADA_ID, m.id]);
    expect(document.body.textContent).toContain("Ada agora usa Escritório.");
    expect(within(card).getByRole("combobox", { name: "Computador de Ada" }).textContent).toContain("Escritório");
    // The row's portrait is the Mac's.
    expect(document.querySelector(".machine-row canvas.ac-computer")?.getAttribute("data-kind")).toBe("mac");
  });

  test("which computer each agent uses: this server's computer, before its runner names it, by what it is", async () => {
    const api = createFakeApi(seedState());
    const agents = [{ id: ADA_ID, name: "Ada", handle: "ada" }];
    fakeMachinesOf.get(api)?.pair({ name: "", kind: "host", agents });
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    const card = screen().getByRole("region", { name: "Qual computador cada agente usa" });
    const trigger = within(card).getByRole("combobox", { name: "Computador de Ada" });
    expect(trigger.textContent).toContain("Computador deste servidor");
  });

  test("members see each agent's computer but don't pick for agents they don't own", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.pair({ name: "Escritório" });
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    const card = screen().getByRole("region", { name: "Qual computador cada agente usa" });
    expect(within(card).queryByRole("combobox")).toBeNull();
    expect(card.textContent).toContain("Sandbox da Daytona");
    // Daytona's settings stay with the admins.
    expect(screen().queryByRole("region", { name: "Sandboxes da Daytona" })).toBeNull();
  });

  test("download: the Mac app from the latest build (version, size, SHA-256), first-run steps, other ways", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const sha = "9f2c4e1b7a3d5f60c8e9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6";
    fakeMachinesOf.get(api)?.setRelease({
      version: "0.2.0",
      url: "/api/desktop/download/0.2.0/agentes_0.2.0_aarch64.dmg",
      sha256: sha,
      publishedAt: "2026-10-16T12:00:00.000Z",
      size: 12 * 1024 * 1024,
    });
    asBrowserOn(MAC_UA);
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    expect(state.calls.find((c) => c.method === "machines.desktopLatest")?.args).toEqual(["darwin", "aarch64"]);
    const card = screen().getByRole("region", { name: "Conectar outro computador" });
    expect(shownText(card)).toContain("Instale o app do agentes.chat no computador.");
    expect(card.querySelector(".ac-computer")?.getAttribute("data-kind")).toBe("mac");
    expect(card.textContent).not.toContain("numa janela própria");
    const download = within(card).getByRole("link", { name: "Baixar o app para macOS" });
    expect(download.getAttribute("href")).toBe(
      "http://localhost:3000/api/desktop/download/0.2.0/agentes_0.2.0_aarch64.dmg",
    );
    expect(card.textContent).toMatch(/Versão 0\.2\.0 · 12\sMB/);
    expect(card.querySelector(".machine-connect__hash")?.textContent).toBe(sha);
    expect(within(card).getByRole("button", { name: "Copiar SHA-256" })).toBeTruthy();
    // What to do with the hash is its ⓘ, not a line under it.
    expect(hintOf("SHA-256", card).text).toBe("Confira se é o mesmo do arquivo baixado: o app só é publicado aqui.");
    expect(shownText(card)).not.toContain("Confira se é o mesmo");
    // The first time's steps stay on the card: they are how to connect it.
    expect(card.textContent).toContain("Na primeira vez");
    expect(card.textContent).toContain("arraste o agentes.chat para Aplicativos");
    expect(card.textContent).toContain("Entre e clique em Usar este Mac em Configurações → Computadores.");
    // Signed and notarized: no Terminal unlock on first run.
    expect(card.textContent).not.toContain("xattr");
    // The old flow is gone: no code made on the site, no install command with a code.
    expect(screen().queryByRole("button", { name: "Gerar comando" })).toBeNull();
    const commands = () => [...card.querySelectorAll(".machine-command__code")].map((el) => el.textContent ?? "");
    // No command before "Outras formas" opens.
    expect(commands()).toEqual([]);
    const other = within(card).getByRole("button", { name: "Outras formas: servidor ou Linux" });
    expect(other.getAttribute("aria-expanded")).toBe("false");
    await click(other);
    const command = commands().at(-1) ?? "";
    expect(command).toBe("curl -fsSL http://localhost:3000/api/machines/install.sh | sh");
    expect(command).not.toContain("--code");
    // A command wider than a phone scrolls beside its copy button, never under it.
    const css = await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".machine-command")).toContain("display: flex");
    expect(rule(".machine-command__copy")).not.toContain("position: absolute");
    expect(shownText(card)).toContain("Rode no terminal do computador e confirme o código que ele mostrar.");
    expect(card.textContent).not.toContain("Não precisa instalar nada antes");
  });

  test("a PC or a Linux computer's browser gets the app for its own system, with its own first step", async () => {
    for (const [ua, target, system, device, kind] of [
      [WINDOWS_UA, "windows", "Windows", "PC", "windows"],
      [LINUX_UA, "linux", "Linux", "computador", "linux"],
    ] as const) {
      cleanup();
      const state = seedState();
      const api = createFakeApi(state);
      fakeMachinesOf.get(api)?.setRelease({
        version: "0.6.0",
        url: `/api/desktop/download/0.6.0/agentes_0.6.0_${target}`,
        sha256: "",
        publishedAt: "2026-10-26T12:00:00.000Z",
        size: null,
      });
      asBrowserOn(ua);
      await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
      await settle(8);
      expect(state.calls.find((c) => c.method === "machines.desktopLatest")?.args).toEqual([target, "x86_64"]);
      const card = screen().getByRole("region", { name: "Conectar outro computador" });
      expect(within(card).getByRole("link", { name: `Baixar o app para ${system}` })).toBeTruthy();
      expect(card.querySelector(".ac-computer")?.getAttribute("data-kind")).toBe(kind);
      const steps = [...card.querySelectorAll(".machine-pair__steps > li")].map((li) => li.textContent);
      expect(steps[0]).toBe("Abra o arquivo baixado para instalar.");
      expect(steps[1]).toContain(`Entre e clique em Usar este ${device} em Configurações → Computadores.`);
      expect(card.textContent).not.toMatch(/Aplicativos|\bMac\b/);
    }
  });

  test("no build published (404): a calm note instead of the button, and nothing to install; the terminal stays", async () => {
    const api = createFakeApi(seedState());
    asBrowserOn(LINUX_UA);
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    const card = screen().getByRole("region", { name: "Conectar outro computador" });
    expect(within(card).queryByRole("link", { name: /^Baixar o app para/ })).toBeNull();
    expect(card.textContent).toContain("O app ainda não está disponível. Por enquanto, use o comando abaixo.");
    expect(card.textContent).not.toContain("Instale o app do agentes.chat");
    expect(within(card).getByRole("button", { name: "Outras formas: servidor ou Linux" })).toBeTruthy();
    // The command below is a shell script, which Windows' own terminal doesn't run.
    cleanup();
    asBrowserOn(WINDOWS_UA);
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api: createFakeApi(seedState()) });
    await settle(8);
    const pc = screen().getByRole("region", { name: "Conectar outro computador" });
    expect(pc.textContent).toContain("O app ainda não está disponível.");
    expect(pc.textContent).not.toContain("use o comando abaixo");
  });

  test("a phone gets no system guessed, and a Linux on another chip no x64 build", async () => {
    const cardOn = async (ua: string) => {
      cleanup();
      const state = seedState();
      const api = createFakeApi(state);
      fakeMachinesOf.get(api)?.setRelease({
        version: "0.6.0",
        url: "/api/desktop/download/0.6.0/agentes_0.6.0_amd64.deb",
        sha256: "",
        publishedAt: "2026-10-26T12:00:00.000Z",
        size: null,
      });
      asBrowserOn(ua);
      await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
      await settle(8);
      expect(state.calls.some((c) => c.method === "machines.desktopLatest")).toBe(false);
      const card = screen().getByRole("region", { name: "Conectar outro computador" });
      expect(within(card).queryByRole("link", { name: /^Baixar o app para/ })).toBeNull();
      expect(card.querySelector(".ac-computer, .machine-pair__steps")).toBeNull();
      expect(within(card).getByRole("button", { name: "Outras formas: servidor ou Linux" })).toBeTruthy();
      return shownText(card);
    };
    // The app goes on the computer: the line alone, never a note that it isn't out.
    const phone = await cardOn(ANDROID_UA);
    expect(phone).toContain("Instale o app do agentes.chat no computador.");
    expect(phone).not.toContain("ainda não está disponível");
    expect(await cardOn(ARM_LINUX_UA)).toContain(
      "O app ainda não está disponível. Por enquanto, use o comando abaixo.",
    );
  });

  test("a row: state, details, live status and pause; it opens the computer's page", async () => {
    const { socket, machines, router } = await go();
    const m = machines.pair({ name: "Escritório" });
    await act(async () => socket.push(orgEvent({ type: "machine.paired", machineId: m.id, name: m.name })));
    await settle(6);
    const row = document.querySelector(".machine-row") as HTMLElement;
    expect(row.textContent).toContain("Escritório");
    expect(row.textContent).toContain("Online");
    expect(row.textContent).toContain("Linux · versão 0.1.0 · conectado agora · Conectado por Walter");
    // The folder is on the computer's page, not in the list.
    expect(row.textContent).not.toContain("/home/runner/agentes");

    // Goes offline: the chip follows the event, no refetch needed.
    await act(async () => socket.push(orgEvent({ type: "machine.status", machineId: m.id, online: false })));
    await settle(2);
    expect(row.textContent).toContain("Offline");
    // Paused on the machine (no `until`: until the owner resumes).
    await act(async () =>
      socket.push(orgEvent({ type: "machine.state", machineId: m.id, paused: { paused: true, until: null } })),
    );
    await settle(2);
    expect(row.textContent).toContain("Pausado");

    await click(within(row).getByRole("link", { name: "Abrir Escritório" }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/computers/${m.id}`);
    expect(screen().getByRole("heading", { name: "Escritório" })).toBeTruthy();
  });

  test("commands off and the agents using it; rename and remove (with our own confirm)", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api);
    const m = machines?.pair({
      name: "Notebook",
      execAllowed: false,
      online: false,
      lastSeenAt: null,
      agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }],
    }) as Machine;
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    const row = document.querySelector(".machine-row") as HTMLElement;
    expect(row.textContent).toContain("Comandos desligados");
    expect(row.textContent).toContain("ainda não conectou");
    expect(row.querySelector(".machine-row__agents [title='Usado por Ada']")).not.toBeNull();

    let menu = await openMenu(within(row).getByRole("button", { name: "Ações de Notebook" }));
    await click(within(menu).getByRole("menuitem", { name: "Renomear" }));
    const rename = screen().getByRole("dialog", { name: "Renomear computador" });
    await type(within(rename).getByLabelText("Nome do computador"), "Notebook do Walter");
    await click(within(rename).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.rename")?.args).toEqual([ORG_ID, m.id, "Notebook do Walter"]);

    menu = await openMenu(
      within(document.querySelector(".machine-row") as HTMLElement).getByRole("button", { name: /^Ações de / }),
    );
    await click(within(menu).getByRole("menuitem", { name: "Remover" }));
    const confirm = screen().getByRole("dialog", { name: "Remover “Notebook do Walter”?" });
    expect(confirm.textContent).toContain("Os agentes que usam ele precisam de outro computador.");
    await click(within(confirm).getByRole("button", { name: "Remover" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.remove")?.args).toEqual([ORG_ID, m.id]);
    expect(document.querySelector(".machine-row")).toBeNull();
  });

  test("this server's own computer: labelled, stopped here with its own words, and turned back on", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api);
    const m = machines?.pair({ name: "srv-1", kind: "host" }) as Machine;
    machines?.setHost({ machineId: m.id, on: true });
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    const row = document.querySelector(".machine-row") as HTMLElement;
    expect(row.textContent).toContain("srv-1");
    expect(row.textContent).toContain("Computador deste servidor");

    const menu = await openMenu(within(row).getByRole("button", { name: "Ações de srv-1" }));
    await click(within(menu).getByRole("menuitem", { name: "Parar de usar neste workspace" }));
    const confirm = screen().getByRole("dialog", { name: "Parar de usar o computador deste servidor?" });
    expect(confirm.textContent).toContain("Dá para voltar a usar quando quiser");
    await click(within(confirm).getByRole("button", { name: "Parar de usar neste workspace" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "machines.remove")?.args).toEqual([ORG_ID, m.id]);

    const off = document.querySelector(".machine-row") as HTMLElement;
    expect(off.textContent).toContain("Este workspace não usa o computador deste servidor.");
    await click(within(off).getByRole("button", { name: "Usar o computador deste servidor" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.hostOn")?.args).toEqual([ORG_ID]);
    expect(document.body.textContent).toContain("Pronto. Ele conecta em até um minuto.");
  });

  test("someone else's machine: no actions", async () => {
    const api = createFakeApi(seedState());
    fakeMachinesOf.get(api)?.pair({ name: "Servidor do João", canManage: false, workspace: null });
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    const row = document.querySelector(".machine-row") as HTMLElement;
    expect(within(row).queryByRole("button", { name: /^Ações de / })).toBeNull();
    expect(row.textContent).not.toContain("Pasta:");
  });
});

describe("an agent's folder request in the chat (ADR 0036 §8)", () => {
  // The server sends `path` and `computer`; the agent is the note's author.
  const params = {
    path: "/Users/you/Projects/loja-v5",
    computer: "MacBook do Walter",
    command: "agentes-runner folders allow /Users/you/Projects/loja-v5 --agent ada",
  };
  const post = (state: ReturnType<typeof seedState>, id: string, bodyCode: string, bodyParams: object) => {
    const base = state.messages[0] as (typeof state.messages)[number];
    state.messages.push({
      ...base,
      id,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Ada asked for a folder.",
      mentionedAgentIds: [],
      meta: { bodyCode, bodyParams },
      createdAt: new Date().toISOString(),
    });
  };

  test("waiting on the computer, with the command for a computer without the app; then Liberado", async () => {
    const state = seedState();
    post(state, "m-ask", "machine_access_requested", params);
    post(state, "m-ok", "machine_access_granted", { path: params.path, computer: params.computer });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(10);
    const ask = document.querySelector('[data-message-id="m-ask"]') as HTMLElement;
    expect(ask.textContent).toContain("Ada pediu a pasta loja-v5 no MacBook do Walter. Esperando a resposta lá.");
    expect(ask.querySelector(".machine-command__code")?.textContent).toBe(params.command);
    const ok = document.querySelector('[data-message-id="m-ok"]') as HTMLElement;
    expect(ok.textContent).toContain("Liberado: Ada já pode usar loja-v5 no MacBook do Walter");
    expect(ok.querySelector(".machine-command__code")).toBeNull();
  });

  test("the notice codes the chat knows", () => {
    expect(taskNoticeOf({ bodyCode: "machine_access_denied", bodyParams: { folder: "x" } })).toEqual({
      code: "machine_access_denied",
      params: { folder: "x" },
    });
    expect(taskNoticeOf({ bodyCode: "machine_access_maybe" })).toBeNull();
    const en = createI18n("en");
    expect(en.t("missions.notice.machine_access_denied", { ...params, agent: "Ada", folder: "loja-v5" })).toBe(
      "Declined: Ada won't use loja-v5 on MacBook do Walter",
    );
  });
});

describe("the computer page: pause, folders and tools (ADR 0036)", () => {
  const LOJA = "/Users/you/Projects/loja-v5";
  const DOCS = "/Users/you/Documents";
  const mac = (over: Partial<Machine> = {}): Partial<Machine> & { name: string } => ({
    name: "MacBook do Walter",
    os: "darwin",
    arch: "arm64",
    agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }],
    access: {
      folders: [
        { path: LOJA, agents: [ADA_ID] },
        { path: DOCS, agents: [] },
      ],
      tools: { claude: true, codex: false, commands: true },
    },
    ...over,
  });
  const open = async (over: Partial<Machine> = {}) => {
    const state = seedState();
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
    const m = machines.pair(mac(over));
    const r = await renderApp(`/org/${ORG_ID}/settings/computers/${m.id}`, { api });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    return { ...r, state, api, machines, m, socket };
  };
  const folderRow = (path: string) => document.querySelector(`[data-folder="${path}"]`) as HTMLElement;
  const reduceCalls = (state: ReturnType<typeof seedState>) =>
    state.calls.filter((c) => c.method === "machines.reduceAccess").map((c) => c.args);

  test("its facts start at the card's edge, under the portrait, whatever the portrait's width", async () => {
    await open();
    expect(document.querySelector(".ac-card > .machine-page__facts")?.textContent).toContain("macOS");
    const css = await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text();
    expect(css).toContain("\n.machine-page__facts {\n  display: flex;");
    // No indent past a portrait: a tower is half as wide as a laptop.
    expect(css).not.toMatch(/\.machine-page__facts\s*\{[^}]*padding/);
  });

  test("the pause set on the machine shows and goes away live", async () => {
    const { m, socket } = await open();
    const head = screen().getByRole("region", { name: "MacBook do Walter" });
    expect(head.textContent).not.toContain("Pausado");
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(until));
    await act(async () =>
      socket.push(orgEvent({ type: "machine.updated", machineId: m.id, paused: { until, timezone: null } })),
    );
    await settle(2);
    // "Pausado até 16:24" (past midnight the date comes first).
    expect(head.textContent).toContain("Pausado até ");
    expect(head.textContent).toContain(time);
    expect(head.textContent).toContain("Pausado no próprio computador por quem o conectou.");
    // The server says "not paused" with null.
    await act(async () => socket.push(orgEvent({ type: "machine.updated", machineId: m.id, paused: null })));
    await settle(2);
    expect(head.textContent).not.toContain("Pausado");
  });

  test("owner: folders with the agents that use them; Remover (one agent, everyone) calls reduce", async () => {
    const { state, m } = await open();
    // The card is its title and its rows: no line under the title.
    expect(shownText(screen().getByRole("region", { name: "Pastas liberadas" }))).not.toContain("pastas a mais");
    const loja = folderRow(LOJA);
    expect(loja.textContent).toContain("loja-v5");
    expect(loja.querySelector("code")?.textContent).toBe(LOJA);
    expect(loja.textContent).toContain("Quem usa loja-v5: Ada");
    expect(folderRow(DOCS).textContent).toContain("Nenhum agente usa ainda");

    let menu = await openMenu(within(loja).getByRole("button", { name: "Ações de loja-v5" }));
    await click(within(menu).getByRole("menuitem", { name: "Só para Ada" }));
    let dialog = screen().getByRole("dialog", { name: "Tirar loja-v5 de Ada?" });
    await click(within(dialog).getByRole("button", { name: "Remover" }));
    await settle(4);
    expect(reduceCalls(state)[0]).toEqual([ORG_ID, m.id, { removeFolder: { path: LOJA, agentId: ADA_ID } }]);
    expect(document.body.textContent).toContain("Ada não usa mais loja-v5.");
    expect(folderRow(LOJA).textContent).toContain("Nenhum agente usa ainda");

    menu = await openMenu(within(folderRow(DOCS)).getByRole("button", { name: "Ações de Documents" }));
    await click(within(menu).getByRole("menuitem", { name: "Remover para todos" }));
    dialog = screen().getByRole("dialog", { name: "Remover Documents?" });
    expect(dialog.textContent).toContain("só no próprio computador");
    await click(within(dialog).getByRole("button", { name: "Remover" }));
    await settle(4);
    expect(reduceCalls(state)[1]).toEqual([ORG_ID, m.id, { removeFolder: { path: DOCS } }]);
    expect(folderRow(DOCS)).toBeNull();
  });

  test("owner: tools on/off; Desligar turns one off; granting is never a button here", async () => {
    const { state, m } = await open();
    const tools = screen().getByRole("region", { name: "Ferramentas" });
    const claude = tools.querySelector('[data-tool="claude"]') as HTMLElement;
    const codex = tools.querySelector('[data-tool="codex"]') as HTMLElement;
    expect(claude.textContent).toContain("Ligado");
    expect(codex.textContent).toContain("Desligado");
    expect(within(codex).queryByRole("button", { name: /^Desligar/ })).toBeNull();
    // Each tool is its name and its ⓘ; that Commands reach past the allowed folders stays in view while it's on.
    expect(hintOf("Claude Code", tools).text).toBe("Escreve e muda arquivos, só nas pastas liberadas.");
    expect(hintOf("Codex", tools).text).toBe("Como o Claude Code, com uma conta do ChatGPT. Só nas pastas liberadas.");
    expect(hintOf("Comandos", tools).text).toBe("Roda comandos do Terminal, como testes e builds.");
    expect(shownText(tools)).not.toMatch(
      /O que os agentes podem rodar|Escreve e muda|Como o Claude Code|Roda comandos/,
    );
    expect(shownText(tools)).toContain("Comandos podem chegar a outras partes do computador");

    await click(within(claude).getByRole("button", { name: "Desligar Claude Code" }));
    const dialog = screen().getByRole("dialog", { name: "Desligar Claude Code?" });
    await click(within(dialog).getByRole("button", { name: "Desligar" }));
    await settle(4);
    expect(reduceCalls(state)).toEqual([[ORG_ID, m.id, { disableTool: "claude" }]]);
    expect((tools.querySelector('[data-tool="claude"]') as HTMLElement).textContent).toContain("Desligado");

    // To grant: on the computer (the app), the terminal command as a fallback; no grant button.
    expect(screen().queryByRole("button", { name: /^(Liberar|Ligar)/ })).toBeNull();
    const grant = screen().getByRole("region", { name: "Para liberar mais" });
    expect(grant.textContent).toContain("abra o app do agentes.chat nele (Preferências → Pastas).");
    expect(grant.textContent).toContain("Sem o app? No terminal do computador:");
    expect(grant.querySelector(".machine-command__code")?.textContent).toBe(
      "agentes-runner folders allow <pasta> --agent <agente>",
    );
  });

  test("the browser off: whoever is at the computer turns it on in the app, or on Linux with the command", async () => {
    const card = () => document.querySelector('[aria-labelledby="sec-machine-browser"]') as HTMLElement;
    await open();
    expect(card().textContent).toContain(
      "Só quem está no computador liga, no app do agentes.chat: Preferências → Ferramentas.",
    );
    expect(card().querySelector(".machine-command__code")).toBeNull();
    cleanup();
    await open({ os: "linux", name: "Servidor", mode: "system" });
    expect(card().textContent).toContain("Sem o app? No terminal do computador:");
    expect(card().querySelector(".machine-command__code")?.textContent).toBe(
      "sudo agentes-runner tools enable browser",
    );
  });

  test("to allow more: the app on a Mac or a PC, the computer's terminal on Linux", async () => {
    const grantText = async (over: Partial<Machine>) => {
      cleanup();
      await open(over);
      return screen().getByRole("region", { name: "Para liberar mais" }).textContent;
    };
    expect(await grantText({ os: "windows", name: "PC da Ana" })).toContain(
      "abra o app do agentes.chat nele (Preferências → Pastas).Sem o app? No terminal do computador:",
    );
    const linux = await grantText({ os: "linux", name: "Servidor", mode: "system" });
    expect(linux).toContain("Liberar é no próprio computador, no Terminal dele, como administrador:");
    expect(linux).not.toContain("app do agentes.chat");
  });

  test("read-only for someone who is neither an admin nor who connected it", async () => {
    const { state } = await open({ canManage: false, workspace: null, pairedBy: { id: "u-joao", name: "João" } });
    expect(document.body.textContent).toContain("Só João e os admins mudam o que este computador libera.");
    expect(document.body.textContent).not.toContain("Daqui você vê");
    expect(screen().queryByRole("button", { name: "Ações de loja-v5" })).toBeNull();
    expect(screen().queryByRole("button", { name: /^Desligar/ })).toBeNull();
    expect(screen().queryByRole("button", { name: /^Ações de MacBook/ })).toBeNull();
    expect(screen().getByRole("region", { name: "Para liberar mais" }).textContent).toContain(
      "Só João libera, no próprio computador.",
    );
    // Still sees what is allowed.
    expect(folderRow(LOJA).textContent).toContain("Quem usa loja-v5: Ada");
    expect(reduceCalls(state)).toEqual([]);
  });

  test("members: the server hides the folders from them; the page says who sees them", async () => {
    await open({ canManage: false, workspace: null, access: null, pairedBy: { id: "u-joao", name: "João" } });
    expect(document.body.textContent).toContain(
      "Só admins e quem conectou veem as pastas e as ferramentas deste computador.",
    );
    expect(document.body.textContent).not.toContain("ainda não informou");
  });

  test("access reported later: a note until the machine says what it allows; then it follows the event", async () => {
    const { m, socket, machines } = await open({ access: null });
    expect(document.body.textContent).toContain("Este computador ainda não informou o que libera.");
    expect(screen().queryByRole("region", { name: "Ferramentas" })).toBeNull();
    const tools = { claude: true, codex: true, commands: false };
    const access = { folders: [{ path: LOJA, agents: [ADA_ID] }], tools };
    // The server says only "it changed" (`access: true`): the page refetches what this person may see.
    machines.patch(m.id, { access });
    await act(async () => socket.push(orgEvent({ type: "machine.updated", machineId: m.id, access: true })));
    await settle(4);
    expect(folderRow(LOJA)).not.toBeNull();
    expect(screen().getByRole("region", { name: "Ferramentas" })).toBeTruthy();
  });

  test("a computer that doesn't exist: a designed state with the way back", async () => {
    const api = createFakeApi(seedState());
    await renderApp(`/org/${ORG_ID}/settings/computers/nope`, { api });
    await settle(8);
    expect(screen().getByText("Computador não encontrado")).toBeTruthy();
    // The way back: the page's own link (the settings menu has one too).
    expect(document.querySelector("a.machine-page__back")?.textContent).toContain("Computadores");
  });

  test("agent page: the folders of its computer this agent may use", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const m = fakeMachinesOf.get(api)?.pair(mac()) as Machine;
    await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=computer`, { api });
    await settle(8);
    const section = document.querySelector("[data-agent-folders]") as HTMLElement;
    expect(section.textContent).toContain("Pastas no computador");
    expect(section.textContent).toContain("Além da própria pasta, usa estas no MacBook do Walter:");
    expect(section.textContent).toContain("loja-v5");
    expect(section.querySelector("code")?.textContent).toBe(LOJA);
    // Allowed on the machine but not for Ada.
    expect(section.textContent).not.toContain(DOCS);
    // Where more is allowed is the label's ⓘ.
    expect(hintOf("Pastas no computador", section).text).toBe(
      "Liberar outra pasta é no próprio computador, por quem o conectou.",
    );
    expect(shownText(section)).not.toContain("Liberar outra pasta");
    // Who runs the computer is its name's ⓘ; the name shows once, with no read-only row naming it again.
    const pc = document.querySelector(".agp-pc") as HTMLElement;
    expect(hintOf("MacBook do Walter", pc).text).toBe(
      "Quem conectou este computador liga, desliga e pausa nele mesmo.",
    );
    expect(shownText(pc)).not.toContain("Quem conectou este computador");
    expect(pc.querySelector(".agp-ro")).toBeNull();
    expect(within(pc).getByRole("button", { name: "Mudar onde trabalha" })).toBeTruthy();
  });

  test("browser: an agent at work in its browser stays in use between its calls (ADR 0040)", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
    const m = machines.pair(
      mac({
        access: { folders: [], tools: { claude: true, codex: false, commands: true, browser: true } },
        browser: { available: true, version: "0.39.1", chrome: "Chrome 141", reason: null },
      }),
    );
    // Ada works in its browser in #eng (a conversation this tab listens to); then that call ends.
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const threadId = state.messages.filter((x) => x.channelId === ENG_ID).at(-1)?.id;
    const ev = (event: Record<string, unknown>) =>
      act(async () =>
        socket.push({
          type: "event",
          channelId: ENG_ID,
          event: { channelId: ENG_ID, threadId, runId: "r-browse", agentId: ADA_ID, ...event },
        }),
      );
    await ev({ type: "agent.thinking" });
    await ev({ type: "agent.tool", tool: "browser_open", detail: "loja.example.com" });
    await ev({ type: "agent.tool", tool: null });
    await act(() =>
      r.router.navigate({
        to: "/org/$orgId/settings/computers/$machineId",
        params: { orgId: ORG_ID, machineId: m.id },
      }),
    );
    await settle(8);
    const card = document.querySelector('[aria-labelledby="sec-machine-browser"]') as HTMLElement;
    // Its title, then its state: no line under the title.
    expect(card.querySelector(".ac-card__sub")).toBeNull();
    expect(card.textContent).toContain("Em uso agora");
    expect(card.textContent).not.toContain("Ninguém usa o navegador agora.");
    expect(card.querySelector(".brw-use")?.textContent).toContain("No navegador");
    expect(within(card).getByRole("button", { name: "Ver" })).toBeTruthy();
  });
});

describe("agent page: which computer", () => {
  // Picking the computer moved to the page's sentence ("Mudar onde trabalha", saved at once):
  // apps/web/test/agent-brain.test.tsx covers it.

  test("members who don't own the agent don't get the selector", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.pair({ name: "Escritório" });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { api });
    await settle(8);
    expect(screen().queryByRole("combobox", { name: "Computador" })).toBeNull();
  });

  test("start/stop on a machine: machine.no_lifecycle is said in the person's language", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n);
    expect(errorText(t, new ApiError(400, "machine.no_lifecycle", "no lifecycle"))).toBe(
      "Este agente usa um computador conectado: quem conectou liga e desliga no próprio computador.",
    );
    expect(errorText(t, new ApiError(413, "artifact.file_too_large", "too large"))).toBe(
      "O arquivo passa de 50 MB, o limite por arquivo.",
    );
    expect(errorText(t, new ApiError(500, "boom", "Server exploded"))).toBe("Server exploded");
    const en = createI18n("en");
    expect(errorText(en.t.bind(en), new ApiError(400, "machine.pairing_invalid", "x"))).toBe(
      "Invalid, used or expired code. Generate another one.",
    );
  });
});

describe("realtime: machines and agent computers", () => {
  const machine = (over: Partial<Machine> = {}): Machine => ({
    id: "m1",
    name: "Escritório",
    online: true,
    lastSeenAt: null,
    hostname: "h",
    os: "linux",
    arch: "x64",
    runnerVersion: "0.1.0",
    execAllowed: true,
    pairedBy: null,
    agents: [],
    workspace: null,
    canManage: true,
    createdAt: "2026-10-15T00:00:00.000Z",
    ...over,
  });
  const pc: AgentComputer = {
    status: "stopped",
    diskUsedGib: 1,
    createdAt: null,
    lastUsedAt: null,
    target: { kind: "machine", machineId: "m1", name: "Escritório", online: true },
  };

  test("status, rename and delete update the list and the agents' views", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.machines(ORG_ID), [machine()]);
    qc.setQueryData(keys.computer(ORG_ID, ADA_ID), pc);
    expect(applyMachineEvent(qc, ORG_ID, { type: "machine.status", machineId: "m1", online: false } as never)).toBe(
      true,
    );
    expect(qc.getQueryData<Machine[]>(keys.machines(ORG_ID))?.[0]?.online).toBe(false);
    expect(qc.getQueryData<AgentComputer>(keys.computer(ORG_ID, ADA_ID))?.target).toMatchObject({ online: false });
    applyMachineEvent(qc, ORG_ID, { type: "machine.updated", machineId: "m1", name: "Sala 2" } as never);
    expect(qc.getQueryData<Machine[]>(keys.machines(ORG_ID))?.[0]?.name).toBe("Sala 2");
    expect(qc.getQueryData<AgentComputer>(keys.computer(ORG_ID, ADA_ID))?.target).toMatchObject({ name: "Sala 2" });
    applyMachineEvent(qc, ORG_ID, { type: "machine.deleted", machineId: "m1" } as never);
    expect(qc.getQueryData<Machine[]>(keys.machines(ORG_ID))).toEqual([]);
    expect(applyMachineEvent(qc, ORG_ID, { type: "agent.typing" })).toBe(false);
  });

  test("pause and access reported by the machine patch the list; an empty update refetches (ADR 0036)", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.machines(ORG_ID), [machine()]);
    const until = "2026-10-17T19:24:00.000Z";
    applyMachineEvent(qc, ORG_ID, { type: "machine.state", machineId: "m1", paused: { paused: true, until } } as never);
    expect(qc.getQueryData<Machine[]>(keys.machines(ORG_ID))?.[0]?.paused).toEqual({ paused: true, until });
    const access = { folders: [{ path: "/p", agents: ["a1", 3] }, { path: "" }], tools: { claude: true } };
    applyMachineEvent(qc, ORG_ID, { type: "machine.access", machineId: "m1", access } as never);
    // Checked and cut like the server does: bad entries dropped, missing tools off.
    expect(qc.getQueryData<Machine[]>(keys.machines(ORG_ID))?.[0]?.access).toEqual({
      folders: [{ path: "/p", agents: ["a1"] }],
      tools: { claude: true, codex: false, commands: false },
    });
    applyMachineEvent(qc, ORG_ID, { type: "machine.updated", machineId: "m1", paused: { paused: false } } as never);
    expect(qc.getQueryData<Machine[]>(keys.machines(ORG_ID))?.[0]?.paused).toEqual({ paused: false });
    expect(qc.getQueryData<Machine[]>(keys.machines(ORG_ID))?.[0]?.name).toBe("Escritório");
    expect(applyMachineEvent(qc, ORG_ID, { type: "machine.updated", machineId: "m1" } as never)).toBe(true);
    expect(qc.getQueryState(keys.machines(ORG_ID))?.isInvalidated).toBe(true);
  });

  test("the server's shapes: `paused: { until }` / null, and `access: true` (refetch)", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.machines(ORG_ID), [machine()]);
    applyMachineEvent(qc, ORG_ID, {
      type: "machine.updated",
      machineId: "m1",
      paused: { until: null, timezone: null },
      access: true,
    } as never);
    expect(qc.getQueryData<Machine[]>(keys.machines(ORG_ID))?.[0]?.paused).toEqual({ paused: true, until: null });
    expect(qc.getQueryState(keys.machines(ORG_ID))?.isInvalidated).toBe(true);
    applyMachineEvent(qc, ORG_ID, { type: "machine.updated", machineId: "m1", paused: null } as never);
    expect(qc.getQueryData<Machine[]>(keys.machines(ORG_ID))?.[0]?.paused).toEqual({ paused: false });
  });

  test("agent.computer with only a target keeps the status", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.computer(ORG_ID, ADA_ID), { ...pc, target: { kind: "cloud" } });
    applyComputerEvent(qc, ORG_ID, {
      type: "agent.computer",
      agentId: ADA_ID,
      target: { kind: "machine", machineId: "m1", name: "Escritório", online: true },
    } as never);
    const view = qc.getQueryData<AgentComputer>(keys.computer(ORG_ID, ADA_ID));
    expect(view?.status).toBe("stopped");
    expect(view?.target).toEqual({ kind: "machine", machineId: "m1", name: "Escritório", online: true });
    // A full view replaces it, keeping the target it doesn't carry.
    applyComputerEvent(qc, ORG_ID, {
      type: "agent.computer",
      agentId: ADA_ID,
      computer: { status: "running", diskUsedGib: 2, createdAt: null, lastUsedAt: null },
    } as never);
    expect(qc.getQueryData<AgentComputer>(keys.computer(ORG_ID, ADA_ID))).toMatchObject({
      status: "running",
      target: { kind: "machine" },
    });
  });
});

describe("file helpers", () => {
  test("previews only raster images and PDF", () => {
    expect(previewKind("image/png")).toBe("image");
    expect(previewKind("image/jpeg; charset=binary")).toBe("image");
    expect(previewKind("application/pdf")).toBe("pdf");
    expect(previewKind("image/svg+xml")).toBeNull();
    expect(previewKind("text/html")).toBeNull();
    expect(previewKind("application/octet-stream")).toBeNull();
  });

  test("icons by name, then type; sizes in the locale", () => {
    expect(fileIcon("foto.JPG")).toBe("image");
    expect(fileIcon("dados.xlsx")).toBe("table");
    expect(fileIcon("site.zip")).toBe("archive");
    expect(fileIcon("contrato.pdf")).toBe("document");
    expect(fileIcon("sem-extensao", "image/webp")).toBe("image");
    expect(fileIcon("binario")).toBe("file");
    expect(formatBytes("pt-BR", 1536)).toContain("1,5");
    expect(formatBytes("en", 3 * 1024 * 1024)).toContain("3");
    expect(formatBytes("en", 3 * 1024 * 1024)).toContain("MB");
  });
});
