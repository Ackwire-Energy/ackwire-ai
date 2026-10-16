import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { Routine } from "@/api/types";
import { createI18n } from "@/i18n";
import { activityText, toolActivity } from "@/lib/activity";
import { onceParts, reminderBody, routineOfMessage } from "@/lib/routines";
import { isDoneOnce } from "@/pages/RoutinesPage";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const DM_ID = "00000000-0000-4000-8000-0000000000d1";
const base = {
  agentId: ADA_ID,
  prompt: "Ligar para o fornecedor",
  running: false,
  createdAt: "2026-10-15T12:00:00.000Z",
};
const once = (at: string) => ({ type: "once" as const, at, timezone: "America/Sao_Paulo", description: "" });
const routines: Routine[] = [
  {
    ...base,
    id: "r-dm",
    name: "Lembrete: ligar para o fornecedor",
    target: { type: "conversation", channelId: DM_ID, threadId: null, reminder: true, forUserId: "u-walter" },
    trigger: once("2026-10-16T12:00:00.000Z"),
    active: true,
    nextRunAt: "2026-10-16T12:00:00.000Z",
    lastRun: null,
  },
  {
    ...base,
    id: "r-thread",
    name: "Resumo do deploy",
    target: { type: "conversation", channelId: GENERAL_ID, threadId: "m-1", reminder: false },
    trigger: once("2026-10-17T18:30:00.000Z"),
    active: true,
    nextRunAt: "2026-10-17T18:30:00.000Z",
    lastRun: null,
  },
  {
    ...base,
    id: "r-done",
    name: "Lembrete: revisar o PR",
    target: { type: "conversation", channelId: ENG_ID, threadId: null, reminder: true },
    trigger: once("2026-10-14T12:00:00.000Z"),
    active: false,
    nextRunAt: null,
    lastRun: { id: "x", at: "2026-10-14T12:00:00.000Z", status: "ok", summary: "Lembrete enviado" },
  },
];

describe("Rotinas: reminders and one-offs from the chat", () => {
  const open = async () => {
    const state = seedState({
      dms: [{ channelId: DM_ID, with: { type: "person", id: "u-joao", name: "Jorge", handle: "jorge" } }],
    });
    const api = createFakeApi(state);
    api.routines.list = async () => routines;
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
  };

  test("Lembrete chip, 'Uma vez · sex, 16/10 às 09:00' (my own zone isn't repeated), where it goes", async () => {
    await open();
    const dm = screen().getByRole("article", { name: "Lembrete: ligar para o fornecedor" });
    expect(dm.textContent).toContain("Lembrete");
    expect(dm.querySelector(".ac-chip svg")).not.toBeNull();
    expect(dm.textContent).toContain("Uma vez · sex, 16/10 às 09:00");
    expect(dm.textContent).not.toContain("Brasília");
    expect(dm.textContent).toContain("na DM com o Jorge");
    // A plain reminder has nothing to run now.
    expect(within(dm).queryByRole("button", { name: "Rodar agora" })).toBeNull();
    const thread = screen().getByRole("article", { name: "Resumo do deploy" });
    expect(thread.textContent).toContain("no #general (thread)");
    expect(thread.textContent).not.toContain("Lembrete");
    // Active shows as a chip; pausing is in Editar.
    expect(within(thread).getByText("Ativa")).toBeTruthy();
  });

  test("fired one-offs are muted under 'Concluídos'", async () => {
    await open();
    expect(screen().queryByRole("article", { name: "Lembrete: revisar o PR" })).toBeNull();
    const toggle = screen().getByRole("button", { name: "Concluídos (1)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(toggle));
    const done = screen().getByRole("article", { name: "Lembrete: revisar o PR" });
    expect(done.hasAttribute("data-done")).toBe(true);
    expect(done.textContent).toContain("Disparado");
    expect(within(done).queryByRole("checkbox")).toBeNull();
  });

  test("rules", () => {
    expect(onceParts("pt-BR", "2026-10-16T12:00:00.000Z", "America/Sao_Paulo")).toEqual({
      weekday: "sex",
      date: "16/10",
      time: "09:00",
      zone: "horário de Brasília",
    });
    expect(routines.map(isDoneOnce)).toEqual([false, false, true]);
  });
});

describe("reminder messages and activity", () => {
  test("a plain reminder is the agent's message with a small 'Lembrete', not the routine style", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-rem",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "@walter Reminder: ligar para o fornecedor",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: { reminder: true, routine: { id: "r-dm", name: "Lembrete: ligar", runId: "x" } },
      createdAt: new Date().toISOString(),
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("ligar para o fornecedor")) as HTMLElement;
    expect(row.textContent).toContain("Ada");
    expect(row.querySelector(".msg-reminder")?.textContent).toBe("Lembrete");
    // The server's English prefix gives way to the translated label (older messages said "Lembrete: …").
    expect(row.textContent).not.toContain("Reminder:");
    expect(reminderBody("@ana Lembrete: pagar", { reminder: true })).toBe("@ana pagar");
    expect(reminderBody("Reminder: x", {})).toBe("Reminder: x");
    expect(row.textContent).not.toContain("Rotina ·");
    expect(routineOfMessage({ reminder: true, routine: { id: "r", name: "x" } })).toBeNull();
    expect(routineOfMessage({ routine: { id: "r", name: "x" } })).toEqual({ id: "r", name: "x" });
  });

  test("a routine's message is one line (whom it called); its instructions open on demand", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-routine",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-walter" },
      body: "@ada Verifique os eventos novos da última hora e avise aqui.",
      mentionedAgentIds: [ADA_ID],
      agentRunId: null,
      meta: { routine: { id: "r-1", name: "Eventos", runId: "x" } },
      createdAt: new Date().toISOString(),
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Rotina · Eventos")) as HTMLElement;
    expect(row.textContent).toContain("Chamou @Ada com as instruções da rotina.");
    expect(row.textContent).not.toContain("Verifique os eventos novos");
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Ver instruções" })));
    expect(row.textContent).toContain("Verifique os eventos novos");
  });

  test("activity verbs for scheduling from the chat", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n);
    const say = (tool: string) =>
      activityText(t, [{ id: "a", type: "agent", name: "Theo", activity: toolActivity(tool) }]);
    expect(say("schedule_reminder")).toBe("Theo está agendando um lembrete…");
    expect(say("create_routine")).toBe("Theo está criando uma rotina…");
  });
});
