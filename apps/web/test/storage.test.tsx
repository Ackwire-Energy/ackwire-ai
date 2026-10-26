import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { createMockStorage } from "./fakes/storage";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (state = seedState()) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/settings/storage`, { api });
  await settle(5);
  return { api, r };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const section = () => screen().getByRole("region", { name: "Armazenamento" });
// Query timers don't run under the test DOM (TanStack sees no window at import): poll by hand.
type Rendered = Awaited<ReturnType<typeof go>>["r"];
const poll = async (r: Rendered, times: number) => {
  for (let i = 0; i < times; i++) {
    await act(() => r.services.queryClient.refetchQueries({ queryKey: keys.storageMigration(ORG_ID) }));
    await settle(2);
  }
};

const fillBucket = async (bucket: string) => {
  const s = within(section());
  await type(s.getByLabelText("Endpoint"), "https://s3.amazonaws.com");
  await type(s.getByLabelText("Região"), "sa-east-1");
  await type(s.getByLabelText("Bucket"), bucket);
  await type(s.getByLabelText("Access key"), "AKIAEXAMPLE1234");
  await type(s.getByLabelText("Secret"), "secret-value-9876");
};
const testConnection = async () => {
  await click(within(section()).getByRole("button", { name: "Testar conexão" }));
  await settle(4);
};
const activate = () => within(section()).getByRole("button", { name: "Ativar" });

describe("Configurações → Armazenamento", () => {
  test("members don't see it", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    expect(screen().queryByRole("region", { name: "Armazenamento" })).toBeNull();
  });

  test("defaults to our storage; Google Drive and OneDrive are coming soon", async () => {
    await go();
    const s = section();
    const ours = within(s).getByRole("radio", { name: /Armazenamento do agentes/ });
    expect(ours.getAttribute("aria-checked")).toBe("true");
    // The title, then the choices: no line between them.
    expect(s.textContent?.indexOf("Armazenamento do agentes")).toBe("Armazenamento".length);
    expect(s.textContent).toContain("Seus arquivos ficam no nosso armazenamento, separados por workspace.");
    expect(s.textContent).toContain("Em uso");
    for (const name of ["Google Drive", "OneDrive"]) {
      const radio = within(s).getByRole("radio", { name: new RegExp(name) });
      expect(radio.hasAttribute("disabled")).toBe(true);
      expect(radio.closest("label")?.textContent).toContain("Em breve");
    }
    expect(within(s).queryByLabelText("Endpoint")).toBeNull();
  });

  test("a failing step shows its error; Ativar waits for a passing test of the same settings", async () => {
    const { api } = await go();
    await click(within(section()).getByRole("radio", { name: /Seu próprio bucket/ }));
    expect(activate().hasAttribute("disabled")).toBe(true);

    // Empty form: the test does not run, fields explain why.
    await testConnection();
    expect(section().textContent).toContain("Preencha este campo.");
    expect(section().textContent).toContain("Informe a access key e o secret.");

    await fillBucket("acme-negado");
    await testConnection();
    const steps = within(section()).getByRole("region", { name: "Resultado do teste" });
    const write = steps.querySelector('[data-step="write"]');
    expect(write?.textContent).toContain("Escrever");
    expect(write?.textContent).toContain("Falhou");
    expect(write?.textContent).toContain("AccessDenied: a chave não pode escrever neste bucket.");
    expect(steps.querySelector('[data-step="read"]')?.textContent).toContain("Não testado");
    expect(steps.textContent).toContain("A conexão não passou no teste.");
    expect(activate().hasAttribute("disabled")).toBe(true);

    await type(within(section()).getByLabelText("Bucket"), "acme-arquivos");
    expect(section().textContent).toContain("As configurações mudaram. Teste de novo antes de ativar.");
    await testConnection();
    const ok = within(section()).getByRole("region", { name: "Resultado do teste" });
    for (const step of ["write", "read", "list", "delete"]) {
      expect(ok.querySelector(`[data-step="${step}"]`)?.textContent).toContain("Funcionou");
    }
    expect(activate().hasAttribute("disabled")).toBe(false);

    // Changing anything asks for a new test.
    await click(within(section()).getByLabelText("Estilo de caminho"));
    expect(activate().hasAttribute("disabled")).toBe(true);
    await click(within(section()).getByLabelText("Estilo de caminho"));
    expect(activate().hasAttribute("disabled")).toBe(false);

    await click(activate());
    await settle(4);
    const s = section();
    expect(s.textContent).toContain("Arquivos antigos continuam onde estão. Novos arquivos vão para o seu bucket.");
    expect(s.textContent).toContain("Usando acme-arquivos em https://s3.amazonaws.com.");
    // Keys are masked: only hints, inputs empty.
    expect(s.textContent).toContain("Salva, termina em 1234. Deixe em branco para manter.");
    expect(s.textContent).toContain("Salva, termina em 9876.");
    expect((within(s).getByLabelText("Secret") as HTMLInputElement).value).toBe("");
    expect(within(s).getByLabelText("Secret").getAttribute("type")).toBe("password");
    expect(s.textContent).not.toContain("secret-value-9876");
    const config = await api.storage.get(ORG_ID);
    expect(config.kind).toBe("s3");
    expect(JSON.stringify(config)).not.toContain("secret-value");
  });

  test("copy existing files shows progress, stops, resumes and finishes", async () => {
    const { r } = await go();
    await click(within(section()).getByRole("radio", { name: /Seu próprio bucket/ }));
    await fillBucket("acme-instavel");
    await testConnection();
    await click(activate());
    await settle(4);
    await click(within(section()).getByRole("button", { name: "Copiar arquivos existentes" }));
    await settle(2);
    expect(within(section()).getByRole("meter", { name: "Progresso da cópia" })).toBeTruthy();
    await poll(r, 1);
    expect(section().textContent).toContain("Copiando arquivos: 40 de 120");
    await poll(r, 1);
    expect(section().textContent).toContain("A cópia parou em 80 de 120.");
    expect(section().textContent).toContain("A conexão com o bucket caiu.");
    await click(within(section()).getByRole("button", { name: "Retomar cópia" }));
    await settle(2);
    await poll(r, 2);
    expect(section().textContent).toContain("Cópia concluída: 120 arquivos no seu bucket.");
    expect(within(section()).getByRole("meter").getAttribute("aria-valuenow")).toBe("120");
  });

  test("switch back to our storage after confirming", async () => {
    const { api } = await go();
    await click(within(section()).getByRole("radio", { name: /Seu próprio bucket/ }));
    await fillBucket("acme-arquivos");
    await testConnection();
    await click(activate());
    await settle(4);
    await click(within(section()).getByRole("button", { name: "Voltar para o armazenamento do agentes" }));
    const dialog = screen().getByRole("dialog", { name: "Voltar para o armazenamento do agentes?" });
    expect(dialog.textContent).toContain("O que já está no seu bucket continua lá.");
    await click(within(dialog).getByRole("button", { name: "Voltar para o armazenamento do agentes" }));
    await settle(4);
    expect((await api.storage.get(ORG_ID)).kind).toBe("agentes");
    expect(section().textContent).not.toContain("Novos arquivos vão para o seu bucket.");
  });
});

describe("storage mock", () => {
  const s3 = { endpoint: "https://r2.example", region: "auto", bucket: "b", prefix: null, pathStyle: true };
  test("activating needs a passing test of the same settings", async () => {
    const m = createMockStorage();
    await expect(m.save("o", { kind: "s3", s3 })).rejects.toThrow();
    expect((await m.test("o", { ...s3, bucket: "lista" })).steps.map((x) => x.ok)).toEqual([true, true, false, false]);
    await m.test("o", s3);
    await expect(m.save("o", { kind: "s3", s3: { ...s3, region: "x" } })).rejects.toThrow();
    expect(
      (await m.save("o", { kind: "s3", s3: { ...s3, accessKeyId: "AK12", secretAccessKey: "SSSS" } })).s3,
    ).toMatchObject({ accessKeyIdHint: "AK12", secretHint: "SSSS" });
  });
});
