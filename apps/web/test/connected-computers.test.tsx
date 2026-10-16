import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ApiError } from "@/api/http";
import { keys } from "@/api/keys";
import type { AgentComputer, Machine } from "@/api/types";
import { fileSaver } from "@/components/artifacts/ArtifactViewer";
import { objectUrls } from "@/components/artifacts/FileView";
import { countdown } from "@/components/Machines";
import { createI18n } from "@/i18n";
import { errorText } from "@/lib/errors";
import { fileIcon, formatBytes, MAX_UPLOAD_BYTES, previewKind } from "@/lib/files";
import { applyComputerEvent, applyMachineEvent } from "@/realtime/machines";
import { ADA_ID, createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
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
});

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

  test("next to Sandbox in the nav; empty state explains it", async () => {
    await go();
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    const links = within(nav)
      .getAllByRole("link")
      .map((l) => l.textContent);
    expect(links.indexOf("Computadores")).toBe(links.indexOf("Sandbox") + 1);
    expect(screen().getByText("Nenhum computador conectado")).toBeTruthy();
    expect(document.body.textContent).toContain("Conecte um servidor, uma VM ou um notebook com o runner do agentes.");
  });

  test("pairing: a name, the install command with the code and time left, steps; live when it connects", async () => {
    const { state, socket, machines } = await go();
    await click(screen().getByRole("button", { name: "Conectar um computador" }));
    const dialog = screen().getByRole("dialog", { name: "Conectar um computador" });
    await click(within(dialog).getByRole("button", { name: "Gerar comando" }));
    expect(dialog.textContent).toContain("Dê um nome ao computador.");
    await type(within(dialog).getByLabelText("Nome do computador"), "Escritório");
    await click(within(dialog).getByRole("button", { name: "Gerar comando" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.createPairing")?.args).toEqual([
      ORG_ID,
      { name: "Escritório" },
    ]);
    expect(dialog.querySelector(".machine-command__code")?.textContent).toContain("--code K7QM-4XTB");
    expect(within(dialog).getByRole("button", { name: "Copiar" })).toBeTruthy();
    expect(dialog.textContent).toMatch(/Código K7QM-4XTB · vale por mais (10:00|9:5\d)/);
    expect(dialog.textContent).toContain("Precisa de Node 22 ou mais novo, ou Bun.");
    expect(dialog.textContent).toContain("acrescente --no-exec ao final");
    expect(dialog.textContent).toContain("usuário do sistema só para o runner");
    expect(dialog.textContent).toContain("Esperando o computador conectar…");

    const m = machines.pair({ name: "Escritório" });
    await act(async () => socket.push(orgEvent({ type: "machine.paired", machineId: m.id, name: m.name })));
    await settle(6);
    expect(dialog.textContent).toContain("Escritório conectou.");
    await click(within(dialog).getByRole("button", { name: "Concluir" }));
    await settle(2);

    const row = document.querySelector(".machine-row") as HTMLElement;
    expect(row.textContent).toContain("Escritório");
    expect(row.textContent).toContain("Online");
    expect(row.textContent).toContain("Linux · x64 · runner 0.1.0 · conectado agora");
    expect(row.textContent).toContain("Conectado por Walter");
    expect(row.textContent).toContain("/home/runner/agentes");

    // Goes offline: the chip follows the event, no refetch needed.
    await act(async () => socket.push(orgEvent({ type: "machine.status", machineId: m.id, online: false })));
    await settle(2);
    expect(row.textContent).toContain("Offline");
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
    expect(row.textContent).toContain("Usado por Ada");

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
    expect(confirm.textContent).toContain("voltam para o PC na nuvem");
    await click(within(confirm).getByRole("button", { name: "Remover" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "machines.remove")?.args).toEqual([ORG_ID, m.id]);
    expect(document.querySelector(".machine-row")).toBeNull();
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

describe("agent page: which computer", () => {
  test("Computador: Nuvem | machine, saved with the save bar; on a machine the cloud controls go away", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const m = fakeMachinesOf.get(api)?.pair({ name: "Escritório" }) as Machine;
    fakeMachinesOf.get(api)?.pair({ name: "Laptop", online: false });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=computer`, { api });
    await settle(8);
    const pc = screen().getByRole("region", { name: "PC da Ada" });
    expect(within(pc).getByRole("button", { name: "Ações do PC da Ada" })).toBeTruthy();
    const trigger = within(pc).getByRole("combobox", { name: "Computador" });
    expect(trigger.textContent).toContain("Nuvem");
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    // Offline machines stay selectable, marked.
    expect(screen().getByRole("option", { name: /^Laptop \(offline\)/ })).toBeTruthy();
    await act(async () => fireEvent.click(screen().getByRole("option", { name: /^Escritório/ })));
    await settle(4);
    // A draft until Salvar.
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")).toBeUndefined();
    expect(pc.textContent).toContain("Antes: Nuvem");
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(6);
    expect(state.calls.find((c) => c.method === "sandbox.setTarget")?.args).toEqual([ORG_ID, ADA_ID, m.id]);
    expect(document.body.textContent).toContain("Alterações da Ada salvas.");
    const after = screen().getByRole("region", { name: "PC da Ada" });
    expect(after.textContent).toContain("Escritório");
    expect(after.textContent).toContain("Online");
    expect(after.textContent).toContain("Liga e desliga com o runner de quem conectou este computador.");
    expect(within(after).queryByRole("button", { name: "Ações do PC da Ada" })).toBeNull();
    expect(after.textContent).not.toContain("GB em disco");
  });

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
      "Este agente usa um computador conectado: quem conectou liga e desliga pelo runner.",
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

  test("countdown: m:ss, null once expired", () => {
    const now = Date.parse("2026-10-15T12:00:00.000Z");
    expect(countdown("2026-10-15T12:10:00.000Z", now)).toBe("10:00");
    expect(countdown("2026-10-15T12:00:05.500Z", now)).toBe("0:06");
    expect(countdown("2026-10-15T11:59:59.000Z", now)).toBeNull();
  });
});
