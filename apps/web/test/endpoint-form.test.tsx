import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

describe("Outro provedor in Settings › Chaves de IA", () => {
  test("named, its models fetched and typed, prices on one, saved and tested: each model's result shows", async () => {
    const state = seedState({
      endpointList: { baseURL: "https://gw.example/v1", models: [{ id: "llama-4" }, { id: "qwen-3" }] },
      endpointChecks: { "qwen-3": { model: "qwen-3", check: "no_tools" } },
    });
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api: createFakeApi(state) });
    await settle(5);
    const keys = screen().getByRole("region", { name: "Chaves de provedor" });
    await click(within(keys).getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    await pick(within(add).getByRole("combobox", { name: "Provedor" }), /Outro provedor/);

    const save = () => within(add).getByRole("button", { name: "Salvar e testar" });
    expect(save().hasAttribute("disabled")).toBe(true);
    await type(within(add).getByLabelText("Nome"), "OpenGateway");
    await type(within(add).getByLabelText("Endereço"), "https://gw.example/v1/");
    await type(within(add).getByLabelText("Chave de API"), "gw-key-1234567");
    await click(within(add).getByRole("button", { name: "Buscar modelos" }));
    expect(state.calls.find((c) => c.method === "agents.endpointModels")?.args[1]).toMatchObject({
      style: "openai",
      baseURL: "https://gw.example/v1/",
      apiKey: "[redacted]",
    });
    // Listed models start off: nothing to save yet.
    expect(save().hasAttribute("disabled")).toBe(true);
    await click(within(add).getByRole("checkbox", { name: "llama-4" }));
    await type(within(add).getByLabelText("llama-4: preço de entrada"), "1");
    expect(add.textContent).toContain("Preencha entrada e saída, ou nenhum dos dois.");
    await type(within(add).getByLabelText("llama-4: preço de saída"), "2,5");
    await type(within(add).getByLabelText("Adicionar um modelo"), "qwen-3");
    await click(within(add).getByRole("button", { name: "Adicionar" }));
    expect(add.textContent).toContain("Um modelo sem preço não custa nada nos orçamentos");
    await click(save());
    await settle(4);

    expect(state.calls.find((c) => c.method === "agents.addCredential")?.args[1]).toEqual({
      provider: "custom",
      label: "OpenGateway",
      apiKey: "[redacted]",
      endpoint: {
        style: "openai",
        baseURL: "https://gw.example/v1",
        models: [{ id: "llama-4", prices: { input: 1, output: 2.5 } }, { id: "qwen-3" }],
      },
    });
    expect(add.textContent).toContain("llama-4 · Funciona, com ferramentas");
    expect(add.textContent).toContain("qwen-3 · Responde, mas não usou ferramenta.");
    await click(within(add).getByRole("button", { name: "Concluir" }));
    expect(screen().queryByRole("dialog", { name: "Adicionar chave de API" })).toBeNull();
  });
});
