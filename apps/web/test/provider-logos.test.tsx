import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { AiPicker } from "@/components/ai/ConnectAiSteps";
import { ExecutorMark } from "@/components/missions/MissionBits";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { proceed, startAs, title } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (path: string, state = seedState()) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
/** The marks drawn inside an element, by id (`data-mark`). */
const marks = (el: Element) => [...el.querySelectorAll<HTMLElement>(".ac-brand")].map((m) => m.dataset.mark);

describe("provider marks where a provider is named", () => {
  test("Settings › keys: each key by its provider's mark; the add dialog's providers too", async () => {
    const state = seedState();
    state.credentials.push({
      id: "cred-2",
      provider: "openai",
      label: "OpenAI do time",
      keyHint: "9a1b",
      createdAt: new Date().toISOString(),
      revokedAt: null,
    });
    await open("settings/keys", state);
    const keys = screen().getByRole("region", { name: "Chaves de provedor" });
    const row = (label: string) => within(keys).getByText(label).closest(".ac-list__row") as HTMLElement;
    expect(marks(row("Claude da Acme"))).toEqual(["claude"]);
    expect(marks(row("OpenAI do time"))).toEqual(["openai"]);

    await act(async () => fireEvent.click(within(keys).getByRole("button", { name: "Adicionar chave" })));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    const trigger = within(add).getByRole("combobox", { name: "Provedor" });
    expect(marks(trigger)).toEqual(["claude"]);
    // Where to get a key, next to the field.
    const site = within(add).getByRole("link", { name: "Crie a chave em platform.claude.com/settings/keys." });
    expect(site.getAttribute("href")).toBe("https://platform.claude.com/settings/keys");
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    expect(marks(screen().getByRole("option", { name: "OpenAI" }))).toEqual(["openai"]);
    // Gemini third, by Google's own sparkle.
    expect(
      screen()
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Claude", "OpenAI", "Gemini", "DeepSeek", "Kimi", "Z.ai", "MiniMax", "OpenRouter"]);
    const gemini = screen().getByRole("option", { name: "Gemini" });
    expect(marks(gemini)).toEqual(["gemini"]);
    expect(gemini.querySelector(".ac-brand img")?.getAttribute("src")).toBe("/brands/gemini.png");
    // OpenRouter's glyph, in the theme's ink like OpenAI's.
    expect(marks(screen().getByRole("option", { name: "OpenRouter" }))).toEqual(["openrouter"]);
  });

  test("Criar agente: each model card names its provider with its mark", async () => {
    await open("agents/new");
    await startAs("Assistente");
    await proceed(4);
    expect(title()).toBe("Modelo e orçamento");
    const card = (name: RegExp) => screen().getByRole("button", { name }).querySelector(".newag__model-prov");
    expect(card(/^Claude Sonnet 5\.5/)?.textContent).toBe("Claude");
    expect(marks(card(/^Claude Sonnet 5\.5/) as Element)).toEqual(["claude"]);
    expect(marks(card(/^GPT-5/) as Element)).toEqual(["openai"]);
  });

  test("the brain line: Claude's mark for Claude Code, Z.ai's for a GLM plan account, none for the API", async () => {
    const withBrain = (brain: NonNullable<ReturnType<typeof seedState>["agents"][number]["brain"]> | undefined) => {
      const state = seedState();
      const ada = state.agents.find((a) => a.id === ADA_ID);
      if (ada) ada.brain = brain;
      return state;
    };
    const brainLine = () => document.querySelector(".channel__brain") as HTMLElement;

    // The workspace's one computer: its name tells nothing apart.
    await open(`dm/agent/${ADA_ID}`, withBrain({ kind: "claude_code", model: "Sonnet", computer: "MacBook" }));
    expect(brainLine().textContent).toBe("Claude Code · Sonnet");
    expect(marks(brainLine())).toEqual(["claude"]);
    expect(brainLine().querySelector(".ac-brand")?.getAttribute("aria-hidden")).toBe("true");
    cleanup();

    // A coding plan names its maker's model; who doesn't see the computer reads whose plan it is.
    await open(`dm/agent/${ADA_ID}`, withBrain({ kind: "claude_code", model: "GLM-5.3", provider: "zai" }));
    expect(brainLine().textContent).toBe("GLM-5.3 pelo Claude Code · plano de João");
    expect(marks(brainLine())).toEqual(["zai"]);
    cleanup();

    await open(`dm/agent/${ADA_ID}`, withBrain({ kind: "codex", model: "GPT-6 Sol" }));
    expect(marks(brainLine())).toEqual(["openai"]);
    cleanup();

    // Thinking through the API: the agent's own icon, no maker's mark.
    await open(`dm/agent/${ADA_ID}`, withBrain(undefined));
    expect(brainLine().textContent).toBe("Claude Sonnet 5.5");
    expect(marks(brainLine())).toEqual([]);
    expect(brainLine().querySelector(".ac-icon")).not.toBeNull();
  });

  test("several makers in one line: the API key row, by four marks, overlapped", () => {
    const { container } = render(<AiPicker choice="claude" onPick={() => {}} panel={null} />);
    const key = container.querySelector(".ac-brand-stack");
    expect(key && marks(key)).toEqual(["claude", "openai", "gemini", "openrouter"]);
    // The row says the makers in words: its marks are decorative.
    expect(key?.getAttribute("aria-hidden")).toBe("true");
  });

  test("missions: Claude Code and Codex by their makers' marks", () => {
    const { container } = render(
      <>
        <ExecutorMark executor="claude" />
        <ExecutorMark executor="codex" />
      </>,
    );
    expect(marks(container)).toEqual(["claude", "openai"]);
  });
});
