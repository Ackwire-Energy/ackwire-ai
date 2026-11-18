import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import type { EndedTask } from "../src/index";
import { runErrorText } from "../src/lib/errors";
import { stopLine, stoppedNoticeOf, stopperName, stopperOf } from "../src/lib/notices";
import { endedText } from "../src/lib/task-manager";
import { replyStopOf, splitCanceled } from "../src/lib/work";

const pt = i18next.createInstance();
void pt.init({ lng: "pt-BR", resources, initAsync: false, interpolation: { escapeValue: false } });
const t: TFunction = pt.t.bind(pt);

describe("whom a stop's line names", () => {
  test("'you' only for who stopped it; the right hand by name even at my word; nobody when no person did", () => {
    expect(stopperOf({ byUserId: "me" }, "me")).toEqual({ kind: "you" });
    expect(stopperOf({ byUserId: "ana" }, "me")).toEqual({ kind: "person", userId: "ana" });
    expect(stopperOf({ byUserId: "me", byAgentId: "lodi" }, "me")).toEqual({ kind: "agent", agentId: "lodi" });
    expect(stopperOf({ byUserId: null }, "me")).toBeNull();
    expect(stopperOf({ byUserId: "me" }, null)).toEqual({ kind: "person", userId: "me" });
  });

  test("the pill's sentence, web and phone alike: you, the right hand, someone else, or nobody to name", () => {
    const names = { agent: (id: string) => (id === "lodi" ? "Lodi" : undefined), person: () => "João" };
    const line = (stop: { byUserId?: string | null; byAgentId?: string | null }) =>
      stopLine(t, "Ada", stopperOf(stop, "me"), names);
    expect(line({ byUserId: "me" })).toBe("Você parou a Ada");
    expect(line({ byUserId: "me", byAgentId: "lodi" })).toBe("Lodi parou a Ada");
    expect(line({ byUserId: "joao" })).toBe("João parou a Ada");
    // Nobody stopped it, or the right hand isn't known: the caller's own words for the stop.
    expect(line({ byUserId: null })).toBeNull();
    expect(line({ byUserId: "me", byAgentId: "gone" })).toBeNull();
    expect(stopperName(stopperOf({ byUserId: "me" }, "me"), names)).toBeNull();
    expect(stopperName(stopperOf({ byUserId: "ana", byAgentId: "lodi" }, "me"), names)).toBe("Lodi");
  });

  test("the notice says the agent that stopped it; an older one reads as the person's", () => {
    const notice = (refs: Record<string, string>) => ({
      notice: { kind: "run_stopped", text: "x", refs: { runId: "r1", was: "working", label: "", ...refs } },
    });
    expect(stoppedNoticeOf(notice({ byUserId: "me", byName: "Ana", byAgentId: "lodi", byAgentName: "Lodi" }))).toEqual({
      runId: "r1",
      byUserId: "me",
      byName: "Ana",
      byAgentId: "lodi",
      byAgentName: "Lodi",
      label: "",
      was: "working",
      reason: null,
    });
    expect(stoppedNoticeOf(notice({ byUserId: "me", byName: "Ana" }))).toMatchObject({
      byAgentId: null,
      byAgentName: "",
    });
  });
});

describe("a stopped reply's record", () => {
  test("who, the agent at their word, or the system's cause in the person's words", () => {
    expect(
      splitCanceled("Lendo.\n\n_Stopped by Lodi for Ana._", {
        canceled: { byUserId: "me", byAgentId: "lodi", text: "Lendo." },
      }),
    ).toEqual({ body: "Lendo.", canceled: true, byUserId: "me", byAgentId: "lodi", code: null });
    const system = splitCanceled("Lendo.\n\n_Stopped._", {
      canceled: { byUserId: null, code: "run.agent_archived", text: "Lendo." },
    });
    expect(system).toEqual({
      body: "Lendo.",
      canceled: true,
      byUserId: null,
      byAgentId: null,
      code: "run.agent_archived",
    });
    expect(runErrorText(t, system.code)).toBe("O agente foi arquivado.");
    // A cause with no words of its own leaves the plain stop line to the app.
    expect(runErrorText(t, "run.failed")).toBeNull();
    // Older replies: `canceled: true`, or the person alone, read as before.
    expect(splitCanceled("Oi\n\n_Interrompido._", { canceled: true })).toEqual({
      body: "Oi",
      canceled: true,
      byUserId: null,
      byAgentId: null,
      code: null,
    });
    expect(replyStopOf({ byUserId: "ana", text: "" })).toEqual({ byUserId: "ana", byAgentId: null, code: null });
    expect(splitCanceled("Oi", undefined)).toEqual({
      body: "Oi",
      canceled: false,
      byUserId: null,
      byAgentId: null,
      code: null,
    });
  });
});

describe("how a task ended", () => {
  const ended = (stoppedBy: EndedTask["stoppedBy"], status: EndedTask["status"] = "canceled") =>
    ({ status, stoppedBy }) as Pick<EndedTask, "status" | "stoppedBy">;
  const names = (id: string) => (id === "lodi" ? "Lodi" : undefined);

  test("'you stopped it' only for who stopped it: anyone else by name, the right hand by its name, nobody plainly", () => {
    expect(endedText(t, ended(null, "done"), "me")).toBe("Terminou");
    expect(endedText(t, ended(null, "failed"), "me")).toBe("Não conseguiu");
    expect(endedText(t, ended({ userId: "me", name: "Bia" }), "me")).toBe("Você parou");
    expect(endedText(t, ended({ userId: "ana", name: "Ana" }), "me")).toBe("Ana parou");
    expect(endedText(t, ended({ userId: "me", name: "Bia", agentId: "lodi" }), "me", names)).toBe("Lodi parou");
    // The system stopped it: never "Você parou".
    expect(endedText(t, ended(null), "me")).toBe("Parada");
    expect(endedText(t, ended({ userId: "ana", name: "" }), "me")).toBe("Parada");
  });
});
